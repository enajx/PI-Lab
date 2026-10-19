import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, relative, sep } from "node:path"
import { getSettingsOrDefaults, MigrationFailure, projects } from "@pi-lab/local-db"
import { app, type BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron"
import { createIPCHandler } from "trpc-electron/main"
import type { BackgroundTraySnapshot } from "../shared/backgroundTray"
import { INTERFACE_LANGUAGE_CHANNEL } from "../shared/interfaceLanguage"
import type { QuickEditTarget } from "../shared/quickEdit"
import {
  type ActivityMonitorPort,
  ActivityRegistry,
  createActivityMonitor,
  systemActivityClock,
  systemActivityScheduler,
} from "./activity"
import { dispatchAutomation } from "./automations/dispatch"
import { AutomationScheduler } from "./automations/scheduler"
import { trayProjectSnapshot } from "./background/projectSnapshot"
import { CaffeineController, electronPowerSaveBlockerAdapter } from "./caffeine"
import { getDb, initDatabase } from "./db/db"
import { getNativeLanguage, nativeText, saveNativeLanguage } from "./i18n/nativeLanguage"
import {
  createElectronAppFocusAdapter,
  createElectronNativeNotificationAdapter,
  createNotificationBrokers,
  NotificationService,
} from "./notifications"
import { livePythonProbe, liveQuickPythonRuntimeResolver } from "./python"
import { liveStandalonePythonDiscoverer } from "./python/standaloneInterpreters"
import { QuickPythonRunner } from "./quickEdit/pythonRun"
import { isTestMode, skillsHomeDirOverride } from "./runtime/env"
import { testSetupProbe } from "./setup/testProbe"
import { TerminalSupervisor } from "./terminal/supervisor"
import { appRouter } from "./trpc/appRouter"
import {
  type AppContext,
  buildAgentCatalog,
  DEFAULT_AGENT_EXECUTABLE_RESOLVER,
  DEFAULT_AGENT_LAUNCH_ENVIRONMENT,
  DEFAULT_HTTP_FETCH,
  DEFAULT_PY_TOOLS_EXEC,
  DEFAULT_PYTHON_ENVIRONMENT_DISCOVERER,
  DEFAULT_PYTHON_RUNTIME_RESOLVER,
  DEFAULT_SETUP_PROBE,
  DEFAULT_SSH_EXEC,
  DEFAULT_WORKFLOW_PROCESS_RUNNER,
} from "./trpc/context"
import { electronThumbnailImageProcessor } from "./trpc/projects/electronThumbnailImage"
import { AnalysisInteractiveController } from "./trpc/science/analysis/interactiveController"
import { seedWritableTemplate } from "./trpc/template"
import { installAppMenu } from "./window/appMenu"

interface FullRuntimeHost {
  getAppIconPath: () => string | null
  ensureMainWindow: () => BrowserWindow
  initialWindow: () => BrowserWindow | null
}

/** Full-app services are imported and constructed after the quick editor has a caret. */
export class FullRuntime {
  private ipcHandler: ReturnType<typeof createIPCHandler> | null = null
  private readonly terminalSupervisor = new TerminalSupervisor(
    isTestMode ? { reapDaemonOnDispose: true } : {},
  )
  private readonly quickPythonRunner = new QuickPythonRunner({
    resolveRuntime: liveQuickPythonRuntimeResolver,
    discoverStandalonePython: liveStandalonePythonDiscoverer,
    projectRootForFile: async (filePath) => this.projectRootForFile(filePath),
    probeRuntime: livePythonProbe,
    getDaemonClient: () => this.terminalSupervisor.ensureClient(),
  })
  private readonly analysisInteractive = new AnalysisInteractiveController()
  private readonly agentCatalog = buildAgentCatalog(isTestMode)
  private readonly notificationBrokers = createNotificationBrokers()
  private readonly notificationService: NotificationService
  private readonly activityRegistry = new ActivityRegistry({
    clock: systemActivityClock,
    scheduler: systemActivityScheduler,
  })
  private activityMonitor: ActivityMonitorPort | null = null
  private caffeineController: CaffeineController | null = null
  private automationScheduler: AutomationScheduler | null = null

  constructor(private readonly host: FullRuntimeHost) {
    this.notificationService = new NotificationService({
      native: createElectronNativeNotificationAdapter(host.getAppIconPath),
      focus: createElectronAppFocusAdapter(host.ensureMainWindow),
      getPreferences: () => getSettingsOrDefaults(getDb()).notifications,
      activations: this.notificationBrokers.activations,
      sounds: this.notificationBrokers.sounds,
      errors: this.notificationBrokers.errors,
      logger: { warn: (message) => console.warn(message) },
    })
  }

  /** Attach the single tRPC handler to a newly created or reopened window. */
  boot(window: BrowserWindow): void {
    if (this.ipcHandler) {
      this.ipcHandler.attachWindow(window)
      return
    }
    this.ipcHandler = createIPCHandler({
      router: appRouter,
      windows: [window],
      createContext: async () => this.createAppContext(),
    })
  }

  /** Migrate local state, start background services, then attach the full window. */
  async start(): Promise<void> {
    const dbStatus = initDatabase()
    ipcMain.on(INTERFACE_LANGUAGE_CHANNEL, (_event, language: unknown) => {
      if (language === getNativeLanguage()) return
      if (saveNativeLanguage(app.getPath("userData"), language)) installAppMenu()
    })
    this.analysisInteractive.installProtocolHandler()
    console.log(
      `[pi-lab] db migrated: applied=${dbStatus.appliedCount} latest=${dbStatus.latestTag ?? "none"} recovered=${dbStatus.recovered}`,
    )
    this.activityMonitor = createActivityMonitor({
      db: getDb(),
      registry: this.activityRegistry,
      getMonitorClient: () => this.terminalSupervisor.ensureMonitorClient(),
      notifications: this.notificationService,
      scheduler: systemActivityScheduler,
      logger: { warn: (message) => console.warn(message) },
    })
    await this.activityMonitor.reconcile().catch((error) => {
      console.warn(`[pi-lab] activity reconciliation skipped: ${String(error)}`)
    })
    this.caffeineController = new CaffeineController({
      power: electronPowerSaveBlockerAdapter,
      clock: systemActivityClock,
      scheduler: systemActivityScheduler,
      activity: this.activityRegistry,
      initialSettings: getSettingsOrDefaults(getDb()).caffeine,
    })
    void seedWritableTemplate().catch((error) => {
      console.warn("[pi-lab] template seed skipped:", error)
    })
    this.startAutomationScheduler()
    installAppMenu()
    const window = this.host.initialWindow()
    if (window) this.boot(window)
  }

  /** Route a quick file to its longest matching registered project. */
  routeForFile(target: QuickEditTarget): string {
    const canonicalPath = realpathSync(target.path)
    let best: { id: string; rootLength: number; relPath: string } | null = null
    for (const project of getDb().select().from(projects).all()) {
      const relPath = relative(project.repoPath, canonicalPath)
      if (
        relPath === "" ||
        relPath === ".." ||
        relPath.startsWith(`..${sep}`) ||
        isAbsolute(relPath)
      ) {
        continue
      }
      if (!best || project.repoPath.length > best.rootLength) {
        best = { id: project.id, rootLength: project.repoPath.length, relPath }
      }
    }
    if (!best) return `/quick-edit?target=${encodeURIComponent(target.id)}`
    return `/projects/${encodeURIComponent(best.id)}?quickFile=${encodeURIComponent(best.relPath)}`
  }

  /** Find the registered project containing a quick-opened file, if any. */
  private projectRootForFile(filePath: string): string | null {
    const canonicalPath = realpathSync(filePath)
    let best: string | null = null
    for (const project of getDb().select({ repoPath: projects.repoPath }).from(projects).all()) {
      const relPath = relative(project.repoPath, canonicalPath)
      if (relPath === ".." || relPath.startsWith(`..${sep}`) || isAbsolute(relPath)) continue
      if (!best || project.repoPath.length > best.length) best = project.repoPath
    }
    return best
  }

  /** Current working and waiting projects for the background popover. */
  traySnapshot(): BackgroundTraySnapshot {
    return trayProjectSnapshot(
      getDb().select({ id: projects.id, name: projects.name }).from(projects).all(),
      this.activityRegistry.snapshot().sessions,
    )
  }

  /** Publish agent activity changes while the popover is open. */
  subscribeTray(listener: (snapshot: BackgroundTraySnapshot) => void): () => void {
    return this.activityRegistry.subscribe(() => listener(this.traySnapshot()))
  }

  /** Read the persisted background preference after the local database opens. */
  keepRunningAfterClose(): boolean {
    return getSettingsOrDefaults(getDb()).keepRunningAfterClose
  }

  /** Seed Quick Editor's Vim cache after the full database starts in the background. */
  editorVim(): boolean {
    return getSettingsOrDefaults(getDb()).editor.vim
  }

  /** Resolve picker choices only when the Quick Editor asks for them. */
  quickPythonOptions(filePath: string) {
    return this.quickPythonRunner.options(filePath)
  }

  /** Keep a Quick Editor interpreter choice in memory for this app session. */
  quickPythonSelect(filePath: string, path: string | null) {
    return this.quickPythonRunner.select(filePath, path)
  }

  /** Start a Python file through the full runtime's shared PTY daemon. */
  quickPythonRun(filePath: string, cols: number, rows: number) {
    return this.quickPythonRunner.run(filePath, cols, rows)
  }

  /** Stop a process started by the Quick Editor. */
  quickPythonKill(sessionId: string) {
    return this.quickPythonRunner.kill(sessionId)
  }

  /** Check a tray project selection against the current local project list. */
  hasProject(id: string): boolean {
    return getDb()
      .select({ id: projects.id })
      .from(projects)
      .all()
      .some((project) => project.id === id)
  }

  /** Close process-owned full-app services on quit. */
  dispose(): void {
    this.automationScheduler?.stop()
    this.caffeineController?.dispose()
    this.activityMonitor?.dispose()
    this.activityRegistry.dispose()
    this.terminalSupervisor.dispose()
    this.analysisInteractive.dispose()
  }

  private startAutomationScheduler(): void {
    if (this.automationScheduler) return
    this.automationScheduler = new AutomationScheduler({
      db: getDb(),
      fire: (args) => dispatchAutomation(this.createAppContext(), args),
    })
    this.automationScheduler.start()
  }

  private createAppContext(): AppContext {
    if (!this.activityMonitor) throw new Error("activity monitor is not initialized")
    if (!this.caffeineController) throw new Error("caffeine controller is not initialized")
    return {
      db: getDb(),
      skillsHomeDir: skillsHomeDirOverride ?? homedir(),
      getDaemonClient: () => this.terminalSupervisor.ensureClient(),
      agentCatalog: this.agentCatalog,
      resolveAgentExecutable: DEFAULT_AGENT_EXECUTABLE_RESOLVER,
      getAgentLaunchEnvironment: DEFAULT_AGENT_LAUNCH_ENVIRONMENT,
      runNonInteractiveProcess: DEFAULT_WORKFLOW_PROCESS_RUNNER,
      setupProbe: isTestMode ? testSetupProbe : DEFAULT_SETUP_PROBE,
      credentialCipher: {
        encrypt: (value) => {
          if (!safeStorage.isEncryptionAvailable()) {
            throw new Error("Your operating system keychain is unavailable for API-key storage")
          }
          return safeStorage.encryptString(value).toString("base64")
        },
      },
      sshExec: DEFAULT_SSH_EXEC,
      httpFetch: DEFAULT_HTTP_FETCH,
      openPath: (path) => shell.openPath(path),
      revealPath: (path) => shell.showItemInFolder(path),
      thumbnailImageProcessor: electronThumbnailImageProcessor,
      pyToolsExec: DEFAULT_PY_TOOLS_EXEC,
      discoverPythonEnvironments: DEFAULT_PYTHON_ENVIRONMENT_DISCOVERER,
      resolvePythonRuntime: DEFAULT_PYTHON_RUNTIME_RESOLVER,
      analysisInteractive: this.analysisInteractive,
      notifications: this.notificationBrokers,
      activityMonitor: this.activityMonitor,
      notificationService: this.notificationService,
      caffeine: this.caffeineController,
    }
  }
}

/** Keep the existing native migration error when the deferred boot fails. */
export function reportFullBootFailure(error: unknown): void {
  if (error instanceof MigrationFailure) {
    dialog.showErrorBox(nativeText("PI Lab database could not be opened"), error.message)
  }
}
