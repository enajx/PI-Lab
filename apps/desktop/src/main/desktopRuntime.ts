import { join } from "node:path"
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  net,
  safeStorage,
  session,
} from "electron"
import { createIPCHandler } from "trpc-electron/main"
import { TOKEN_HEADER } from "../server/access"
import type { BackgroundTraySnapshot } from "../shared/backgroundTray"
import { INTERFACE_LANGUAGE_CHANNEL } from "../shared/interfaceLanguage"
import type { QuickEditTarget } from "../shared/quickEdit"
import { createDesktopRouter, desktopContext } from "./desktop/desktopRouter"
import { getNativeLanguage, nativeText, saveNativeLanguage } from "./i18n/nativeLanguage"
import { channelIdentity, type PiLabChannel } from "./identity/channel"
import { installNotebookFrameHeaders } from "./notebooks/notebookFrames"
import {
  createAppFocusAdapter,
  createNativeNotificationAdapter,
  createNotificationBrokers,
  type NativeNotificationAdapter,
  type NotificationRequest,
  type NotificationSoundId,
} from "./notifications"
import { isTestMode, rendererDevServerUrl } from "./runtime/env"
import { createServerClient, type ServerClient } from "./server/client"
import {
  ensureServer,
  type ServerEndpoint,
  ServerStartFailure,
  serverBuildId,
} from "./server/launcher"
import { MEDIA_SCHEME, REPORT_SCHEME } from "./trpc/science/analysis/mediaGrants"
import { publicReleaseFromPackage } from "./updates/release"
import type { QuitWork, RememberedQuitChoice } from "./window/userQuit"

interface DesktopRuntimeHost {
  getAppIconPath: () => string | null
  ensureMainWindow: () => BrowserWindow
  initialWindow: () => BrowserWindow | null
  channel: PiLabChannel
}

/** Settings Electron main reads outside the renderer, kept current by the server. */
interface AppSettings {
  keepRunningAfterClose: boolean
  quitChoice: RememberedQuitChoice
  editorVim: boolean
}

/** Notebook servers use this port range (see the server's NotebookServers). */
const NOTEBOOK_PORTS = { start: 42_700, end: 42_799 }

/**
 * The desktop app as a client of the PI Lab server. Starts or adopts the
 * server, serves the Electron-only router over IPC, shows this device's
 * notifications and forwards custom URL schemes. Holds no project data.
 */
export class DesktopRuntime {
  private ipcHandler: ReturnType<typeof createIPCHandler> | null = null
  private endpoint: ServerEndpoint | null = null
  private serverClient: ReturnType<typeof createServerClient> | null = null
  private readonly ready: Promise<ServerClient>
  private resolveReady: (client: ServerClient) => void = () => undefined
  private rejectReady: (error: unknown) => void = () => undefined
  private readonly brokers = createNotificationBrokers()
  private readonly native: NativeNotificationAdapter
  private readonly alerted = new Set<string>()
  private settings: AppSettings = {
    keepRunningAfterClose: true,
    quitChoice: "ask",
    editorVim: false,
  }
  private tray: BackgroundTraySnapshot = { projects: [] }
  private readonly trayListeners = new Set<(snapshot: BackgroundTraySnapshot) => void>()
  private readonly unsubscribers: Array<() => void> = []

  constructor(private readonly host: DesktopRuntimeHost) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // A failed start is reported by start(); later waiters see the same error.
    this.ready.catch(() => undefined)
    this.native = createNativeNotificationAdapter(host.getAppIconPath, {
      platform: process.platform,
      isSupported: () => Notification.isSupported(),
      create: (input) => new Notification(input),
    })
  }

  /** The server client once connected; rejects if the server could not start. */
  server(): Promise<ServerClient> {
    return this.ready
  }

  /** The renderer's server address and token (asked over IPC by the preload). */
  async rendererEndpoint(): Promise<{ url: string }> {
    await this.ready
    const endpoint = this.endpoint
    if (!endpoint) throw new Error("PI Lab server is not connected")
    return {
      url: `ws://127.0.0.1:${endpoint.port}/trpc?token=${encodeURIComponent(endpoint.token)}`,
    }
  }

  /** Attach the desktop tRPC handler to a newly created or reopened window. */
  boot(window: BrowserWindow): void {
    if (this.ipcHandler) {
      this.ipcHandler.attachWindow(window)
      return
    }
    this.ipcHandler = createIPCHandler({
      router: createDesktopRouter({
        server: () => this.server(),
        rendererEndpoint: () => this.rendererEndpoint(),
      }),
      windows: [window],
      createContext: async () => desktopContext(this.brokers),
    })
  }

  /** Start or adopt the server, connect, and set up this device's side. */
  async start(): Promise<void> {
    ipcMain.on(INTERFACE_LANGUAGE_CHANNEL, (_event, language: unknown) => {
      if (language === getNativeLanguage()) return
      if (saveNativeLanguage(app.getPath("userData"), language)) {
        void import("./window/appMenu").then(({ installAppMenu }) => installAppMenu())
        void this.server().then((client) => client.server.reloadLanguage.mutate())
      }
    })
    this.installSchemeForwarding()
    installNotebookFrameHeaders(
      (port) => port >= NOTEBOOK_PORTS.start && port <= NOTEBOOK_PORTS.end,
      isAppPageUrl,
    )
    const window = this.host.initialWindow()
    if (window) this.boot(window)
    try {
      await this.connect()
    } catch (error) {
      this.rejectReady(error)
      throw error
    }
  }

  private async connect(): Promise<void> {
    const serverEntry = join(__dirname, "server.js")
    const dataDir = app.getPath("userData")
    this.endpoint = await ensureServer({
      config: {
        dataDir,
        channel: this.host.channel,
        packaged: app.isPackaged,
        resourcesDir: app.isPackaged
          ? process.resourcesPath
          : join(__dirname, "..", "..", "resources"),
        build: serverBuildId(serverEntry),
        version: app.getVersion(),
        port: 0,
      },
      serverEntry,
      launchdLabel:
        app.isPackaged && !isTestMode && process.platform === "darwin"
          ? `${channelIdentity(this.host.channel).autostartName}.server`
          : null,
      log: (message) => console.log(message),
    })
    console.log(`[pi-lab] connected to server pid ${this.endpoint.pid} port ${this.endpoint.port}`)
    this.serverClient = createServerClient(this.endpoint)
    const client = this.serverClient.client
    const release = publicReleaseFromPackage(app.isPackaged, app.getAppPath())
    await client.server.initPublicUpdateChannel.mutate(
      release ? { channel: release.channel } : null,
    )
    this.settings = await client.server.appSettings.query()
    this.tray = await client.server.traySnapshot.query()
    this.subscribe(client)
    await this.moveLegacyCredentials(client)
    this.resolveReady(client)
  }

  /** Live tray data, settings changes and this device's notification alerts. */
  private subscribe(client: ServerClient): void {
    const tray = client.server.onTray.subscribe(undefined, {
      onData: (snapshot) => {
        this.tray = snapshot
        for (const listener of this.trayListeners) listener(snapshot)
      },
      onError: (error) => console.warn(`[pi-lab] tray updates stopped: ${String(error)}`),
    })
    const settings = client.server.onAppSettings.subscribe(undefined, {
      onData: (value) => {
        this.settings = value
      },
      onError: (error) => console.warn(`[pi-lab] settings updates stopped: ${String(error)}`),
    })
    const alerts = client.server.onNotification.subscribe(undefined, {
      onData: (message) => {
        if (message.type === "cleared") return
        if (this.alerted.has(message.event.id)) return
        this.alerted.add(message.event.id)
        this.alert(message.event.request, message.event.sound)
      },
      onError: (error) => console.warn(`[pi-lab] notifications stopped: ${String(error)}`),
    })
    this.unsubscribers.push(
      () => tray.unsubscribe(),
      () => settings.unsubscribe(),
      () => alerts.unsubscribe(),
    )
  }

  /** Show one alert on this device unless a PI Lab window has focus. */
  private alert(request: NotificationRequest, sound: NotificationSoundId): void {
    const focus = createAppFocusAdapter({
      hasFocusedWindow: () => BrowserWindow.getFocusedWindow() !== null,
      getWindows: () => BrowserWindow.getAllWindows(),
      createWindow: this.host.ensureMainWindow,
      focusApp: () => app.focus({ steal: true }),
    })
    if (focus.isFocused()) return
    this.brokers.sounds.publish({ sound })
    const fail = (message: string): void => {
      const surfaced = `Native notification delivery failed: ${message}`
      console.warn(surfaced)
      this.brokers.errors.publish({ message: surfaced })
    }
    if (!this.native.isSupported()) {
      fail("Native notifications are not supported on this system")
      return
    }
    this.native.deliver(
      { title: request.title, body: request.body, silent: true },
      {
        onClick: () => {
          focus.restoreAndFocus()
          this.brokers.activations.publish(request.target)
        },
        onFailure: fail,
      },
    )
  }

  /**
   * Move credentials saved by an older PI Lab (Electron safeStorage) into the
   * server's secret store, one row at a time, so an interrupted move finishes
   * at the next start. A value that cannot be decrypted stays and is reported.
   */
  private async moveLegacyCredentials(client: ServerClient): Promise<void> {
    const legacy = await client.server.legacyCredentials.query()
    if (legacy.length === 0) return
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn("[pi-lab] saved keys could not be moved: the system keychain is unavailable")
      return
    }
    for (const row of legacy) {
      const plaintext = safeStorage.decryptString(Buffer.from(row.encryptedValue, "base64"))
      await client.server.moveLegacyCredential.mutate({ ...row, plaintext })
    }
    console.log(`[pi-lab] moved ${legacy.length} saved key(s) to the server's secret store`)
  }

  /** Analysis reports and media stream from the server through the same token. */
  private installSchemeForwarding(): void {
    for (const scheme of [REPORT_SCHEME, MEDIA_SCHEME]) {
      session.defaultSession.protocol.handle(scheme, async (request) => {
        await this.ready
        const endpoint = this.endpoint
        if (!endpoint) return new Response(null, { status: 503 })
        const url = new URL(request.url)
        const headers: Record<string, string> = { [TOKEN_HEADER]: endpoint.token }
        const range = request.headers.get("range")
        if (range) headers.range = range
        return net.fetch(
          `http://127.0.0.1:${endpoint.port}/scheme/${scheme}/${url.host}${url.pathname}`,
          { headers },
        )
      })
    }
  }

  /** The project route for a quick-opened file, or the quick-file view outside every project. */
  async routeForFile(target: QuickEditTarget): Promise<string> {
    const found = await (await this.server()).server.projectForFile.query({ path: target.path })
    if (!found) return `/quick-edit?target=${encodeURIComponent(target.id)}`
    return `/projects/${encodeURIComponent(found.projectId)}?quickFile=${encodeURIComponent(found.relPath)}`
  }

  traySnapshot(): BackgroundTraySnapshot {
    return this.tray
  }

  subscribeTray(listener: (snapshot: BackgroundTraySnapshot) => void): () => void {
    this.trayListeners.add(listener)
    return () => this.trayListeners.delete(listener)
  }

  keepRunningAfterClose(): boolean {
    return this.settings.keepRunningAfterClose
  }

  quitChoice(): RememberedQuitChoice {
    return this.settings.quitChoice
  }

  async rememberQuitChoice(choice: "background"): Promise<void> {
    await (await this.server()).server.rememberQuitChoice.mutate({ choice })
  }

  editorVim(): boolean {
    return this.settings.editorVim
  }

  async hasProject(id: string): Promise<boolean> {
    return (await this.server()).server.hasProject.query({ id })
  }

  async quitWork(): Promise<QuitWork> {
    return (await this.server()).server.quitWork.query()
  }

  /** Stop every agent and terminal, then the server itself (Quit dialog's stop choice). */
  async stopServerAndAgents(): Promise<void> {
    const client = await this.server()
    await client.server.stop.mutate({ stopAgents: true })
  }

  async quickPythonOptions(path: string) {
    return (await this.server()).server.quickPythonOptions.query({ path })
  }

  async quickPythonSelect(path: string, interpreter: string | null) {
    return (await this.server()).server.quickPythonSelect.mutate({ path, interpreter })
  }

  async quickPythonRun(path: string, cols: number, rows: number) {
    return (await this.server()).server.quickPythonRun.mutate({ path, cols, rows })
  }

  async quickPythonKill(sessionId: string) {
    await (await this.server()).server.quickPythonKill.mutate({ sessionId })
  }

  /**
   * Disconnect on quit. The server keeps running; test runs stop the server
   * they started unless `PI_LAB_TEST_RETAIN_SERVER=1`.
   */
  async dispose(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    const connection = this.serverClient
    if (connection && isTestMode && process.env.PI_LAB_TEST_RETAIN_SERVER !== "1") {
      await connection.client.server.stop
        .mutate({ stopAgents: process.env.PI_LAB_TEST_RETAIN_DAEMON !== "1" })
        .catch((error: unknown) =>
          console.warn(`[pi-lab] test server stop failed: ${String(error)}`),
        )
    }
    connection?.close()
  }
}

/** PI Lab's own page: the dev server in development, the packaged file:// page otherwise. */
function isAppPageUrl(url: string): boolean {
  if (rendererDevServerUrl) return url.startsWith(`${new URL(rendererDevServerUrl).origin}/`)
  return url.startsWith("file:")
}

/** Show the database migration error when the server could not open the database. */
export function reportServerStartFailure(error: unknown): void {
  if (error instanceof ServerStartFailure && error.detail.kind === "migration") {
    dialog.showErrorBox(nativeText("PI Lab database could not be opened"), error.message)
    return
  }
  dialog.showErrorBox(
    "PI Lab could not start its server",
    String(error instanceof Error ? error.message : error),
  )
}
