import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
import {
  agentSessions,
  automationRuns,
  automations,
  getAgentSettingsOrDefaults,
  getSettingsOrDefaults,
  MigrationFailure,
  projects,
  projectWorkflowRuns,
  resolveDataDir,
} from "@pi-lab/local-db"
import { eq, max, ne, sql } from "drizzle-orm"
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
import { ActivityStatusFeed } from "./activity/statusFeed"
import { agentLaunchLifecycle } from "./agents/launchLifecycle"
import { prepareAgentQuit } from "./agents/quitPolicy"
import {
  dispatchAutomation,
  hasRunningProjectAutomation,
  restoreAutomationProcess,
} from "./automations/dispatch"
import { ManagedProcesses } from "./automations/managedProcesses"
import { AutomationScheduler } from "./automations/scheduler"
import { trayProjectSnapshot } from "./background/projectSnapshot"
import { CaffeineController, electronPowerSaveBlockerAdapter } from "./caffeine"
import { getDb, initDatabase } from "./db/db"
import { getNativeLanguage, nativeText, saveNativeLanguage } from "./i18n/nativeLanguage"
import { channelFromAppName } from "./identity/channel"
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
} from "./trpc/context"
import { electronThumbnailImageProcessor } from "./trpc/projects/electronThumbnailImage"
import {
  completePlanningProcess,
  listPlanningAgentSessions,
  reconcilePlanningSessions,
} from "./trpc/projects/planning"
import { AnalysisInteractiveController } from "./trpc/science/analysis/interactiveController"
import { seedWritableTemplate } from "./trpc/template"
import { hasRunningProjectWorkflow, restoreProjectWorkflow } from "./trpc/workflows/workflows"
import { publicReleaseFromPackage } from "./updates/release"
import { initializePublicUpdateChannel } from "./updates/selection"
import { installAppMenu } from "./window/appMenu"

interface FullRuntimeHost {
  getAppIconPath: () => string | null
  ensureMainWindow: () => BrowserWindow
  initialWindow: () => BrowserWindow | null
  openAgentSettings: () => void
}

/** Full-app services are imported and constructed after the quick editor has a caret. */
export class FullRuntime {
  private ipcHandler: ReturnType<typeof createIPCHandler> | null = null
  private readonly terminalSupervisor = new TerminalSupervisor(
    isTestMode && process.env.PI_LAB_TEST_RETAIN_DAEMON !== "1"
      ? { reapDaemonOnDispose: true }
      : {},
  )
  private readonly quickPythonRunner = new QuickPythonRunner({
    resolveRuntime: liveQuickPythonRuntimeResolver,
    discoverStandalonePython: liveStandalonePythonDiscoverer,
    projectRootForFile: async (filePath) => this.projectRootForFile(filePath),
    probeRuntime: livePythonProbe,
    getDaemonClient: () => this.terminalSupervisor.ensureClient(),
  })
  private readonly managedProcesses = new ManagedProcesses(
    join(resolveDataDir(), "agent-processes"),
    () => this.terminalSupervisor.ensureClient(),
  )
  private readonly processFinalizers = new Set<Promise<void>>()
  private readonly analysisInteractive = new AnalysisInteractiveController()
  private readonly agentCatalog = buildAgentCatalog(isTestMode)
  private readonly notificationBrokers = createNotificationBrokers()
  private readonly notificationService: NotificationService
  private readonly activityRegistry = new ActivityRegistry({
    clock: systemActivityClock,
    scheduler: systemActivityScheduler,
  })
  private activityStatus: ActivityStatusFeed | null = null
  private startupReady: Promise<void> = Promise.resolve()
  private agentLaunchReady: Promise<void> | null = null
  private activityMonitor: ActivityMonitorPort | null = null
  private caffeineController: CaffeineController | null = null
  private automationScheduler: AutomationScheduler | null = null

  constructor(private readonly host: FullRuntimeHost) {
    this.notificationService = new NotificationService({
      suppressDelivery: isTestMode,
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
      createContext: async () => {
        await this.startupReady
        return this.createAppContext()
      },
    })
  }

  /** Show the window after database setup; hold IPC contexts until reconciliation finishes. */
  async start(): Promise<void> {
    const dbStatus = initDatabase()
    initializePublicUpdateChannel(
      getDb(),
      publicReleaseFromPackage(app.isPackaged, app.getAppPath()),
    )
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
    this.caffeineController = new CaffeineController({
      power: electronPowerSaveBlockerAdapter,
      clock: systemActivityClock,
      scheduler: systemActivityScheduler,
      activity: this.activityRegistry,
      initialSettings: getSettingsOrDefaults(getDb()).caffeine,
    })
    this.activityStatus = new ActivityStatusFeed(getDb(), this.activityRegistry)
    this.startupReady = this.ensureAgentRecovery().catch((error) => {
      console.warn(`[pi-lab] activity reconciliation skipped: ${String(error)}`)
    })
    const window = this.host.initialWindow()
    if (window) this.boot(window)
    await this.startupReady
    void seedWritableTemplate().catch((error) => {
      console.warn("[pi-lab] template seed skipped:", error)
    })
    this.startAutomationScheduler()
    installAppMenu()
  }

  /** Share recovery work; a failed connection can be retried by the next launch. */
  private ensureAgentRecovery(): Promise<void> {
    if (this.agentLaunchReady) return this.agentLaunchReady
    if (!this.activityMonitor) return Promise.reject(new Error("Agent monitor is not ready"))
    this.agentLaunchReady = this.activityMonitor
      .reconcile()
      .then(async () => {
        await this.reconcilePlanningAgents()
        await this.recoverBackgroundAgents()
      })
      .catch((error: unknown) => {
        this.agentLaunchReady = null
        throw error
      })
    return this.agentLaunchReady
  }

  /** Attach only unclaimed durable owners, including uncertain spawn replies. */
  private async recoverBackgroundAgents(): Promise<void> {
    await this.managedProcesses.recover((metadata, process) => {
      const ctx = this.createAppContext()
      const completion =
        metadata.kind === "automation"
          ? restoreAutomationProcess(ctx, metadata, process)
          : metadata.kind === "project-workflow"
            ? restoreProjectWorkflow(ctx, metadata, process)
            : metadata.kind === "planning"
              ? process.completion.then(async (result) => {
                  await completePlanningProcess(metadata, result)
                  await process.acknowledge?.()
                })
              : Promise.reject(new Error(`Unknown recovered agent mode: ${metadata.kind}`))
      this.trackFinalizer(completion)
    })
  }

  /** Route a quick file to its longest matching registered project. */
  routeForFile(target: QuickEditTarget): string {
    const canonicalPath = realpathSync(target.path)
    let best: { id: string; rootLength: number; relPath: string } | null = null
    for (const project of getDb()
      .select({ id: projects.id, repoPath: projects.repoPath })
      .from(projects)
      .all()) {
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

  /** Recent opened projects and durable agent activity, plus all currently live work. */
  traySnapshot(): BackgroundTraySnapshot {
    const db = getDb()
    const recentAgents = db
      .select({
        projectId: agentSessions.projectId,
        at: max(agentSessions.updatedAt).as("agent_at"),
      })
      .from(agentSessions)
      .groupBy(agentSessions.projectId)
      .as("recent_agents")
    const recentWorkflows = db
      .select({
        projectId: projectWorkflowRuns.projectId,
        at: max(projectWorkflowRuns.lastCheckedAt).as("workflow_at"),
      })
      .from(projectWorkflowRuns)
      .groupBy(projectWorkflowRuns.projectId)
      .as("recent_workflows")
    const recentRoutines = db
      .select({
        projectId: automations.projectId,
        at: sql<
          number | null
        >`max(coalesce(${automationRuns.completedAt}, ${automationRuns.launchedAt}))`.as(
          "routine_at",
        ),
      })
      .from(automationRuns)
      .innerJoin(automations, eq(automationRuns.automationId, automations.id))
      .groupBy(automations.projectId)
      .as("recent_routines")
    const rows = db
      .select({
        id: projects.id,
        name: projects.name,
        opened: projects.lastOpenedAt,
        agent: recentAgents.at,
        workflow: recentWorkflows.at,
        routine: recentRoutines.at,
      })
      .from(projects)
      .leftJoin(recentAgents, eq(projects.id, recentAgents.projectId))
      .leftJoin(recentWorkflows, eq(projects.id, recentWorkflows.projectId))
      .leftJoin(recentRoutines, eq(projects.id, recentRoutines.projectId))
      .all()
    return trayProjectSnapshot(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        lastActivityAt: Math.max(row.opened, row.agent ?? 0, row.workflow ?? 0, row.routine ?? 0),
      })),
      [
        ...this.activityRegistry.snapshot().sessions,
        ...rows
          .filter((row) => hasRunningProjectWorkflow(row.id) || hasRunningProjectAutomation(row.id))
          .map((row) => ({ projectId: row.id, state: "working" as const })),
      ],
      Date.now(),
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

  /** Count all managed agent modes, including result fetching, before a user quit choice. */
  async runningAgentCount(): Promise<number> {
    await this.ensureAgentRecovery()
    await this.recoverBackgroundAgents()
    return (await this.liveTerminalAgents()).length + (await this.managedProcesses.runningCount())
  }

  /** Explicit Quit stops work; programmatic quits retain the saved policy. */
  async prepareQuit(stopConfirmed: boolean): Promise<boolean> {
    try {
      await this.ensureAgentRecovery()
      return await prepareAgentQuit({
        pause: async () => {
          await agentLaunchLifecycle.pause()
          await this.recoverBackgroundAgents()
        },
        resume: () => agentLaunchLifecycle.resume(),
        behavior: () => (stopConfirmed ? "stop" : getAgentSettingsOrDefaults(getDb()).quitBehavior),
        count: async () =>
          (await this.liveTerminalAgents()).length + (await this.managedProcesses.runningCount()),
        confirm: async (count) => {
          if (stopConfirmed) return "stop"
          const result = await dialog.showMessageBox({
            type: "warning",
            title: "Agents are running",
            message: `${count} agent${count === 1 ? " is" : "s are"} still running.`,
            detail:
              "Your Settings say to stop agents when quitting PI Lab. Quitting will stop them. To leave agents running in the background, change When quitting PI Lab in Settings → Agents & worktrees.",
            buttons: ["Cancel", "Quit and stop agents", "Open Settings"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          })
          return result.response === 1 ? "stop" : result.response === 2 ? "settings" : "cancel"
        },
        settings: () => this.host.openAgentSettings(),
        stop: async () => {
          this.automationScheduler?.stop()
          await Promise.all([this.stopTerminalAgents(), this.managedProcesses.stopAll()])
          await Promise.all([...this.processFinalizers])
        },
      })
    } catch (error) {
      agentLaunchLifecycle.resume()
      this.automationScheduler?.start()
      dialog.showErrorBox(
        "Could not quit PI Lab",
        `Agents could not be safely stopped or checked. The app remains open.\n${String(error)}`,
      )
      return false
    }
  }

  /** Only PI Lab agent sessions are affected; ordinary shells and Python runs are separate. */
  private async liveTerminalAgents() {
    const rows = getDb()
      .select({ sessionId: agentSessions.sessionId })
      .from(agentSessions)
      .where(ne(agentSessions.state, "exited"))
      .all()
    const planning = await listPlanningAgentSessions()
    const ids = new Set([...rows, ...planning].map((row) => row.sessionId))
    if (ids.size === 0) return []
    return (await (await this.terminalSupervisor.ensureClient()).list()).filter(
      (session) => ids.has(session.id) && session.alive,
    )
  }

  private async stopTerminalAgents(): Promise<void> {
    let sessions = await this.liveTerminalAgents()
    if (sessions.length === 0) {
      await this.reconcilePlanningAgents()
      return
    }
    const client = await this.terminalSupervisor.ensureClient()
    // Kill the whole agent group together, including children that ignore SIGTERM.
    await Promise.all(sessions.map((session) => client.kill(session.id, "SIGKILL")))
    const deadline = Date.now() + 2_000
    do {
      sessions = await this.liveTerminalAgents()
      if (sessions.length === 0) {
        await this.activityMonitor?.reconcile()
        await this.reconcilePlanningAgents()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    } while (Date.now() < deadline)
    throw new Error("Some agents did not stop; quit was cancelled")
  }

  private async reconcilePlanningAgents(): Promise<void> {
    if ((await listPlanningAgentSessions()).length === 0) return
    const sessions = await (await this.terminalSupervisor.ensureClient()).list()
    await reconcilePlanningSessions(
      new Set(sessions.filter((session) => session.alive).map((session) => session.id)),
    )
  }

  private trackFinalizer(completion: Promise<void>): void {
    this.processFinalizers.add(completion)
    void completion
      .finally(() => this.processFinalizers.delete(completion))
      .catch((error) => {
        console.error("[pi-lab] background agent result could not be saved", error)
      })
  }

  /** Close process-owned full-app services on quit. */
  dispose(): void {
    this.automationScheduler?.stop()
    this.caffeineController?.dispose()
    this.activityMonitor?.dispose()
    this.activityRegistry.dispose()
    this.managedProcesses.dispose()
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
    if (!this.activityStatus) throw new Error("activity status is not initialized")
    if (!this.activityMonitor) throw new Error("activity monitor is not initialized")
    if (!this.caffeineController) throw new Error("caffeine controller is not initialized")
    return {
      db: getDb(),
      appChannel: channelFromAppName(app.getName()),
      skillsHomeDir: skillsHomeDirOverride ?? homedir(),
      bundledSkillsDir: app.isPackaged
        ? join(process.resourcesPath, "skills")
        : join(__dirname, "..", "..", "resources", "skills"),
      getDaemonClient: () => this.terminalSupervisor.ensureClient(),
      agentCatalog: this.agentCatalog,
      resolveAgentExecutable: DEFAULT_AGENT_EXECUTABLE_RESOLVER,
      getAgentLaunchEnvironment: async () => {
        await this.ensureAgentRecovery()
        return DEFAULT_AGENT_LAUNCH_ENVIRONMENT()
      },
      runNonInteractiveProcess: this.managedProcesses.run,
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
      activityStatus: this.activityStatus,
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
