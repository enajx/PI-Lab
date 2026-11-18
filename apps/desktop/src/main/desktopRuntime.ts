import { hostname } from "node:os"
import { join } from "node:path"
import { resolveDataDir } from "@pi-lab/local-db/paths"
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
import { readDiscovery, readMachineId, TOKEN_HEADER } from "../server/access"
import type { BackgroundTraySnapshot } from "../shared/backgroundTray"
import { INTERFACE_LANGUAGE_CHANNEL } from "../shared/interfaceLanguage"
import type { QuickEditTarget } from "../shared/quickEdit"
import { createDesktopRouter, desktopContext } from "./desktop/desktopRouter"
import { getNativeLanguage, nativeText, saveNativeLanguage } from "./i18n/nativeLanguage"
import { channelIdentity, type PiLabChannel } from "./identity/channel"
import {
  DEFAULT_REMOTE_APP_PATH,
  DEFAULT_REMOTE_DATA_DIR,
  DEFAULT_REMOTE_ENROLL_COMMAND,
  DEFAULT_REMOTE_SERVER_PREFIX,
  MachineConnections,
  type RemoteAccess,
} from "./machines/machineConnections"
import { localServerAtStart } from "./machines/machineStore"
import { findServerBundle, type ServerBundleFiles } from "./machines/serverBundle"
import { installNotebookFrameHeaders } from "./notebooks/notebookFrames"
import { stopNotebooksWithWindow } from "./notebooks/notebookServers"
import {
  createAppFocusAdapter,
  createNativeNotificationAdapter,
  createNotificationBrokers,
  type NativeNotificationAdapter,
  type NotificationRequest,
  type NotificationSoundId,
} from "./notifications"
import { isTestMode, rendererDevServerUrl } from "./runtime/env"
import { createServerClient, type ServerClient, serverSocketUrl } from "./server/client"
import {
  createEndpointCache,
  type EndpointCache,
  ensureServer,
  isPiLabServerProcess,
  removeLaunchdAgent,
  SERVER_START_NO_PROGRESS_MS,
  type ServerEndpoint,
  ServerStartFailure,
  serverBuildId,
  serverLaunchConfig,
} from "./server/launcher"
import { SSH_PATH } from "./server/tunnel"
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

/** Why calls to the local server fail in a session started with "Local server: Off". */
const LOCAL_SERVER_OFF_MESSAGE =
  "This Mac's PI Lab server is off (Settings > Machines > Local server)."

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
  private endpoints: EndpointCache | null = null
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
  private connecting: Promise<void> | null = null
  private machineConnections: MachineConnections | null = null

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

  /** Remote machines (see machines/machineConnections.ts); created in start(). */
  machines(): MachineConnections {
    if (!this.machineConnections) throw new Error("Machines are not loaded yet")
    return this.machineConnections
  }

  /** The renderer's server address and token (asked over IPC by the preload). */
  async rendererEndpoint(): Promise<{ url: string }> {
    await this.ready
    const endpoint = await this.currentEndpoint()
    // Test seam (typing tests): the renderer's sockets go through a latency
    // proxy on this port, which forwards to the port in server.json.
    const proxyPort = isTestMode ? process.env.PI_LAB_TEST_RENDERER_PROXY_PORT : undefined
    return {
      url: serverSocketUrl(proxyPort ? { ...endpoint, port: Number(proxyPort) } : endpoint),
    }
  }

  /**
   * Where the server listens now, checked with its identity proof before
   * anyone sends it the token. A restarted server (launchd after a crash, a
   * new build) picks a new port and serverId, which `server.json` names; the
   * check runs again then, and after a closed connection or a failed
   * forwarded request. The token stays the same.
   */
  private currentEndpoint(): Promise<ServerEndpoint> {
    const endpoints = this.endpoints
    if (!endpoints) throw new Error("PI Lab server is not connected")
    return endpoints.get()
  }

  /** Attach the desktop tRPC handler to a newly created or reopened window. */
  boot(window: BrowserWindow): void {
    // The notebook tabs and Analysis previews live in this window's page; their
    // processes run in the PI Lab server. Agents and routines keep running.
    stopNotebooksWithWindow(window, window.webContents, async () => {
      const client = await this.server()
      await Promise.all([
        client.server.stopNotebooks.mutate(),
        client.server.stopAnalysisPreviews.mutate(),
      ])
    })
    if (this.ipcHandler) {
      this.ipcHandler.attachWindow(window)
      return
    }
    this.ipcHandler = createIPCHandler({
      router: createDesktopRouter({
        server: () => this.server(),
        rendererEndpoint: () => this.rendererEndpoint(),
        machines: () => this.machines(),
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
    const profileDir = app.getPath("userData")
    const mode = localServerAtStart(profileDir)
    this.machineConnections = new MachineConnections({
      profileDir,
      access: remoteAccess(),
      deviceName: `PI Lab on ${hostname()}`,
      // With the local server off, the id it had (so it is still not added as a machine).
      localMachineId: async () =>
        mode === "off"
          ? readMachineId(resolveDataDir())
          : (await (await this.server()).server.hello.query()).machineId,
      bundle: carriedServerBundle,
      log: (message) => console.log(message),
    })
    if (isTestMode) {
      ;(globalThis as { piLabTestMachines?: MachineConnections }).piLabTestMachines =
        this.machineConnections
    }
    installNotebookFrameHeaders(
      (port) => port >= NOTEBOOK_PORTS.start && port <= NOTEBOOK_PORTS.end,
      isAppPageUrl,
    )
    const window = this.host.initialWindow()
    if (window) this.boot(window)
    // Only "Always" keeps the launchd agent: it would start the server at login.
    const launchdLabel =
      app.isPackaged && !isTestMode && process.platform === "darwin"
        ? `${channelIdentity(this.host.channel).autostartName}.server`
        : null
    if (launchdLabel !== null && mode !== "always") removeLaunchdAgent(launchdLabel)
    if (mode === "off") {
      console.log("[pi-lab] local server is off; connecting to the added machines only")
      this.rejectReady(new Error(LOCAL_SERVER_OFF_MESSAGE))
      this.machineConnections.start()
      return
    }
    try {
      this.connecting = this.connect(mode === "always" ? launchdLabel : null)
      await this.connecting
      this.machineConnections.start()
    } catch (error) {
      this.rejectReady(error)
      throw error
    }
  }

  /** launchdLabel: null starts the server as a detached child, which stops with the app's Quit. */
  private async connect(launchdLabel: string | null): Promise<void> {
    const serverEntry = join(__dirname, "server.js")
    this.endpoint = await ensureServer({
      config: serverLaunchConfig({
        channel: this.host.channel,
        packaged: app.isPackaged,
        resourcesDir: app.isPackaged
          ? process.resourcesPath
          : join(__dirname, "..", "..", "resources"),
        build: serverBuildId(serverEntry),
        version: app.getVersion(),
        profileDir: app.getPath("userData"),
      }),
      serverEntry,
      launchdLabel,
      log: (message) => console.log(message),
      noProgressMs: SERVER_START_NO_PROGRESS_MS,
    })
    console.log(`[pi-lab] connected to server pid ${this.endpoint.pid} port ${this.endpoint.port}`)
    this.endpoints = createEndpointCache(resolveDataDir(), this.endpoint.token)
    const endpoints = this.endpoints
    this.serverClient = createServerClient(
      () => this.currentEndpoint(),
      () => endpoints.invalidate(),
    )
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
   * at the next start. A value that cannot be decrypted stays unmoved, the
   * user is told once, and startup goes on.
   */
  private async moveLegacyCredentials(client: ServerClient): Promise<void> {
    const legacy = await client.server.legacyCredentials.query()
    if (legacy.length === 0) return
    const failed: string[] = []
    for (const row of legacy) {
      const plaintext = safeStorage.isEncryptionAvailable()
        ? decryptLegacy(row.encryptedValue)
        : null
      if (plaintext === null) {
        failed.push(row.key)
        continue
      }
      await client.server.moveLegacyCredential.mutate({ ...row, plaintext })
    }
    console.log(`[pi-lab] moved ${legacy.length - failed.length} saved key(s) to the server`)
    if (failed.length > 0) {
      dialog.showErrorBox(
        "Some saved keys could not be moved",
        `PI Lab could not read ${failed.length} key(s) saved by an older version (${failed.join(", ")}). Allow Keychain access when macOS asks, or enter these keys again in Settings.`,
      )
    }
  }

  /**
   * Analysis reports and media stream from the server through the same token.
   * A request that cannot reach the server checks the endpoint again and is
   * sent once more (the server may have restarted on another port).
   */
  private installSchemeForwarding(): void {
    for (const scheme of [REPORT_SCHEME, MEDIA_SCHEME]) {
      session.defaultSession.protocol.handle(scheme, async (request) => {
        await this.ready
        const url = new URL(request.url)
        const headers: Record<string, string> = {}
        const range = request.headers.get("range")
        if (range) headers.range = range
        const forward = async () => {
          const endpoint = await this.currentEndpoint()
          return net.fetch(
            `http://127.0.0.1:${endpoint.port}/scheme/${scheme}/${url.host}${url.pathname}`,
            { headers: { ...headers, [TOKEN_HEADER]: endpoint.token }, redirect: "error" },
          )
        }
        return forward().catch((error: unknown) => {
          console.warn(`[pi-lab] ${scheme} request failed, checking the server again: ${error}`)
          this.endpoints?.invalidate()
          return forward()
        })
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

  /**
   * Read the tray data again from the server and tell the listeners. Projects opened or
   * runs recorded since the last activity change only show after this read.
   */
  async refreshTray(): Promise<BackgroundTraySnapshot> {
    // No local server: the tray shows no projects.
    if (localServerAtStart(app.getPath("userData")) === "off") return this.tray
    const snapshot = await (await this.server()).server.traySnapshot.query()
    this.tray = snapshot
    for (const listener of this.trayListeners) listener(snapshot)
    return snapshot
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

  /** Open notebook tabs whose servers run (the Quit dialog names them). */
  async notebookCount(): Promise<number> {
    return (await this.server()).server.notebookCount.query()
  }

  /** Stop every agent and terminal, then the server itself (Quit dialog's stop choice). */
  async stopServerAndAgents(): Promise<void> {
    const client = await this.server()
    await client.server.stop.mutate({ stopAgents: true })
  }

  /**
   * True when Quit should also stop this Mac's server and agents: the app
   * started a local server and "Local server" is now Only while PI Lab is
   * open or Off.
   */
  stopsServerOnQuit(): boolean {
    if (this.serverClient === null || this.machineConnections === null) return false
    return this.machineConnections.deviceSettings().localServer !== "always"
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
    await this.machineConnections?.close()
    if (isTestMode && process.env.PI_LAB_TEST_RETAIN_SERVER !== "1") await this.stopTestServer()
    const connection = this.serverClient
    connection?.close()
  }

  /**
   * A test run must never leave its server behind (its data folder is deleted
   * next), also when the app quits while it is still starting the server.
   */
  private async stopTestServer(): Promise<void> {
    const bounded = (work: Promise<unknown>, ms: number) =>
      Promise.race([work.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, ms))])
    await bounded(this.connecting ?? Promise.resolve(), 4_000)
    const connection = this.serverClient
    if (connection) {
      await bounded(
        connection.client.server.stop.mutate({
          stopAgents: process.env.PI_LAB_TEST_RETAIN_DAEMON !== "1",
        }),
        3_000,
      )
    }
    const pid = readDiscovery(resolveDataDir())?.pid ?? this.endpoint?.pid
    if (!pid || !processAlive(pid) || !isPiLabServerProcess(pid, resolveDataDir())) return
    if (!connection) process.kill(pid, "SIGTERM")
    const deadline = Date.now() + 2_000
    while (processAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (processAlive(pid)) {
      console.warn(`[pi-lab] test server ${pid} did not stop; killing it`)
      process.kill(pid, "SIGKILL")
    }
  }
}

/**
 * How remote machines are reached: the user's ssh and the defaults, or in
 * test mode a test sshd (`PI_LAB_TEST_SSH_ARGS`, a JSON array), a temp remote
 * data folder and a remote enroll command.
 */
function remoteAccess(): RemoteAccess {
  const env = isTestMode ? process.env : {}
  return {
    sshPath: SSH_PATH,
    extraSshArgs: env.PI_LAB_TEST_SSH_ARGS
      ? (JSON.parse(env.PI_LAB_TEST_SSH_ARGS) as string[])
      : [],
    dataDir: env.PI_LAB_TEST_REMOTE_DATA_DIR ?? DEFAULT_REMOTE_DATA_DIR,
    serverPrefix: env.PI_LAB_TEST_REMOTE_PREFIX ?? DEFAULT_REMOTE_SERVER_PREFIX,
    appPath: env.PI_LAB_TEST_REMOTE_APP_PATH ?? DEFAULT_REMOTE_APP_PATH,
    enrollCommand: env.PI_LAB_TEST_REMOTE_ENROLL ?? DEFAULT_REMOTE_ENROLL_COMMAND,
    // Tests: no launchd agent, and the installed server runs in test mode.
    installArgs: isTestMode ? ["--no-launchd"] : [],
    installEnv: isTestMode ? { PI_LAB_TEST_MODE: "1" } : {},
  }
}

/**
 * The server bundle this app carries: `Resources/server-bundle/` in a
 * packaged app, `release/server/` (from package-server-bundle.cjs) in source runs.
 */
function carriedServerBundle(): ServerBundleFiles | null {
  if (app.isPackaged) {
    const dir = join(process.resourcesPath, "server-bundle")
    return findServerBundle(dir, join(dir, "install.sh"))
  }
  const desktopDir = join(__dirname, "..", "..")
  return findServerBundle(
    join(desktopDir, "release", "server"),
    join(desktopDir, "scripts", "server-install", "install.sh"),
  )
}

/** Decrypt a value the old app saved with safeStorage, or null when it cannot be read. */
function decryptLegacy(encrypted: string): string | null {
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"))
  } catch (error) {
    console.warn(`[pi-lab] an old saved key could not be decrypted: ${String(error)}`)
    return null
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
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
