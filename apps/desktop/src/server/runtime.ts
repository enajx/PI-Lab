import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
import {
  agentSessions,
  automationRuns,
  automations,
  getSettingsOrDefaults,
  projects,
  projectWorkflowRuns,
  worktrees,
} from "@pi-lab/local-db"
import { eq, max, ne, sql } from "drizzle-orm"
import {
  type ActivityMonitorPort,
  ActivityRegistry,
  createActivityMonitor,
  systemActivityClock,
  systemActivityScheduler,
} from "../main/activity"
import { ActivityStatusFeed } from "../main/activity/statusFeed"
import { agentLaunchLifecycle } from "../main/agents/launchLifecycle"
import {
  dispatchAutomation,
  hasRunningProjectAutomation,
  restoreAutomationProcess,
} from "../main/automations/dispatch"
import { ManagedProcesses } from "../main/automations/managedProcesses"
import { AutomationScheduler } from "../main/automations/scheduler"
import { trayProjectSnapshot } from "../main/background/projectSnapshot"
import { CaffeineController } from "../main/caffeine"
import { getDb, initDatabase } from "../main/db/db"
import { DICTATION_MODELS, type DictationModel, withTestPins } from "../main/dictation/catalog"
import { resolveWhisperServer, WhisperServerEngine } from "../main/dictation/engine"
import type { MicrophonePort } from "../main/dictation/service"
import { DictationService } from "../main/dictation/service"
import { stopRunningRenders } from "../main/documents/render"
import { loadNativeLanguage } from "../main/i18n/nativeLanguage"
import { tectonicCacheDir } from "../main/latex/runtime"
import { NotebookServers } from "../main/notebooks/notebookServers"
import { createNotificationBrokers } from "../main/notifications"
import { livePythonProbe, liveQuickPythonRuntimeResolver } from "../main/python"
import { liveStandalonePythonDiscoverer } from "../main/python/standaloneInterpreters"
import { QuickPythonRunner } from "../main/quickEdit/pythonRun"
import { isTestMode, rendererDevServerUrl, skillsHomeDirOverride } from "../main/runtime/env"
import { testSetupProbe } from "../main/setup/testProbe"
import { busyTerminals } from "../main/terminal/busyTerminals"
import { TerminalSupervisor } from "../main/terminal/supervisor"
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
} from "../main/trpc/context"
import { nodeThumbnailImageProcessor } from "../main/trpc/projects/nodeThumbnailImage"
import {
  completePlanningProcess,
  listPlanningAgentSessions,
  reconcilePlanningSessions,
} from "../main/trpc/projects/planning"
import { AnalysisInteractiveController } from "../main/trpc/science/analysis/interactiveController"
import { analysisMedia } from "../main/trpc/science/analysis/mediaGrants"
import { WorkerAnalysisPreview } from "../main/trpc/science/analysis/previewWorker"
import { seedWritableTemplate } from "../main/trpc/template"
import { hasRunningProjectWorkflow, restoreProjectWorkflow } from "../main/trpc/workflows/workflows"
import type { QuitWork } from "../main/window/userQuit"
import type { BackgroundTraySnapshot } from "../shared/backgroundTray"
import { caffeinateAdapter } from "./caffeinate"
import type { ServerConfig } from "./config"
import { NotificationFeed } from "./notificationFeed"
import { createSecretStore, macKeychain, type SecretStore } from "./secrets"
import { trashPath } from "./trash"

/** Microphone access belongs to the client device; the server never asks for it. */
const clientOnlyMicrophone: MicrophonePort = {
  status: () => "not-determined",
  request: () => Promise.reject(new Error("The microphone is handled by the PI Lab app")),
  openSettings: () => Promise.reject(new Error("The microphone is handled by the PI Lab app")),
}

/** Opening things on screen is a client action; the server refuses it. */
function clientOnly(action: string): never {
  throw new Error(`${action} runs in the PI Lab app, not on the server`)
}

/**
 * All PI Lab services that do not need a window: database, agents, routines,
 * terminals, status and notifications. Runs in the server process with no
 * Electron, and keeps working while no client is connected.
 */
export class ServerRuntime {
  private readonly terminalSupervisor = new TerminalSupervisor(
    isTestMode && process.env.PI_LAB_TEST_RETAIN_DAEMON !== "1"
      ? { reapDaemonOnDispose: true }
      : {},
  )
  readonly quickPython = new QuickPythonRunner({
    resolveRuntime: liveQuickPythonRuntimeResolver,
    discoverStandalonePython: liveStandalonePythonDiscoverer,
    projectRootForFile: async (filePath) => this.projectRootForFile(filePath),
    probeRuntime: livePythonProbe,
    getDaemonClient: () => this.terminalSupervisor.ensureClient(),
  })
  private readonly managedProcesses: ManagedProcesses
  private readonly processFinalizers = new Set<Promise<void>>()
  readonly analysisInteractive = new AnalysisInteractiveController()
  private readonly analysisPreview = new WorkerAnalysisPreview(__dirname)
  // A first uvx run downloads marimo or JupyterLab, so a server may take minutes to start.
  readonly notebookServers = new NotebookServers(
    { start: 42_700, end: 42_799 },
    5 * 60_000,
    rendererDevServerUrl ? new URL(rendererDevServerUrl).origin : null,
    async () => clientOnly("Opening a notebook in the browser"),
  )
  private readonly agentCatalog = buildAgentCatalog(isTestMode)
  private readonly notificationBrokers = createNotificationBrokers()
  readonly notifications: NotificationFeed
  readonly activityRegistry = new ActivityRegistry({
    clock: systemActivityClock,
    scheduler: systemActivityScheduler,
  })
  readonly secrets: SecretStore
  private activityStatus: ActivityStatusFeed | null = null
  private agentLaunchReady: Promise<void> | null = null
  private activityMonitor: ActivityMonitorPort | null = null
  private caffeineController: CaffeineController | null = null
  private automationScheduler: AutomationScheduler | null = null
  private dictation: DictationService | null = null
  private readonly appSettingsListeners = new Set<() => void>()

  constructor(readonly config: ServerConfig) {
    this.managedProcesses = new ManagedProcesses(join(config.dataDir, "agent-processes"), () =>
      this.terminalSupervisor.ensureClient(),
    )
    this.notifications = new NotificationFeed(
      config.dataDir,
      () => getSettingsOrDefaults(getDb()).notifications,
      isTestMode && process.env.PI_LAB_TEST_NOTIFICATIONS !== "1",
    )
    this.secrets = createSecretStore({ dataDir: config.dataDir, keychain: macKeychain })
  }

  /** Open the database, reconcile agents with the PTY daemon, start routines. */
  async start(): Promise<void> {
    const dbStatus = initDatabase()
    loadNativeLanguage(this.config.dataDir)
    console.log(
      `[pi-lab server] db migrated: applied=${dbStatus.appliedCount} latest=${dbStatus.latestTag ?? "none"}`,
    )
    this.activityMonitor = createActivityMonitor({
      db: getDb(),
      registry: this.activityRegistry,
      getMonitorClient: () => this.terminalSupervisor.ensureMonitorClient(),
      notifications: this.notifications,
      scheduler: systemActivityScheduler,
      logger: { warn: (message) => console.warn(message) },
    })
    this.notifications.watch(this.activityRegistry)
    this.caffeineController = new CaffeineController({
      power: caffeinateAdapter,
      clock: systemActivityClock,
      scheduler: systemActivityScheduler,
      activity: this.activityRegistry,
      initialSettings: getSettingsOrDefaults(getDb()).caffeine,
    })
    this.activityStatus = new ActivityStatusFeed(getDb(), this.activityRegistry)
    const whisperServer = resolveWhisperServer(join(this.config.resourcesDir, "whisper"))
    const enginePidFile = join(this.config.dataDir, "dictation", "whisper-server.pid")
    this.dictation = new DictationService({
      db: getDb(),
      catalog: dictationCatalog(),
      modelsDir: join(this.config.dataDir, "dictation", "models"),
      engine: whisperServer ? new WhisperServerEngine(whisperServer, enginePidFile) : null,
      fetch: DEFAULT_HTTP_FETCH,
      microphone: clientOnlyMicrophone,
      idleMs: 10 * 60_000,
      enginePidFile,
      downloadStallMs: 30_000,
    })
    void this.dictation.start().catch((error) => {
      console.warn(`[pi-lab server] dictation cleanup failed: ${String(error)}`)
    })
    await this.ensureAgentRecovery().catch((error) => {
      console.warn(`[pi-lab server] activity reconciliation skipped: ${String(error)}`)
    })
    void seedWritableTemplate().catch((error) => {
      console.warn("[pi-lab server] template seed skipped:", error)
    })
    this.startAutomationScheduler()
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

  /** Route a file to its longest matching registered project, or null outside every project. */
  projectRouteForFile(path: string): { projectId: string; relPath: string } | null {
    const canonicalPath = realpathSync(path)
    let best: { projectId: string; rootLength: number; relPath: string } | null = null
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
        best = { projectId: project.id, rootLength: project.repoPath.length, relPath }
      }
    }
    return best ? { projectId: best.projectId, relPath: best.relPath } : null
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

  /** Tell desktop apps that a setting they keep a copy of may have changed. */
  appSettingsChanged(): void {
    for (const listener of this.appSettingsListeners) listener()
  }

  onAppSettingsChanged(listener: () => void): () => void {
    this.appSettingsListeners.add(listener)
    return () => this.appSettingsListeners.delete(listener)
  }

  /** Check a project id against the current project list. */
  hasProject(id: string): boolean {
    return getDb()
      .select({ id: projects.id })
      .from(projects)
      .all()
      .some((project) => project.id === id)
  }

  /**
   * Work "stop server and agents" would stop: all managed agent modes,
   * including result fetching, and shells or Python runs running a command.
   * Does not start the PTY daemon when none is running.
   */
  async quitWork(): Promise<QuitWork> {
    await this.ensureAgentRecovery()
    await this.recoverBackgroundAgents()
    const agents =
      (await this.liveTerminalAgents()).length + (await this.managedProcesses.runningCount())
    const db = getDb()
    const roots = [
      ...db.select({ project: projects.name, path: projects.repoPath }).from(projects).all(),
      ...db
        .select({ project: projects.name, path: worktrees.path })
        .from(worktrees)
        .innerJoin(projects, eq(worktrees.projectId, projects.id))
        .all(),
    ]
    const sessions = await this.terminalSupervisor.listSessionsIfRunning()
    return {
      agents,
      terminals: busyTerminals(sessions, await this.agentSessionIds(), roots),
      notebooks: this.notebookServers.runningCount(),
    }
  }

  /**
   * Stop every agent, fetch, shell, Python run, notebook and the PTY daemon,
   * so no PI Lab work remains. Launches stay paused; the server exits next.
   */
  async stopAllWork(): Promise<void> {
    await this.ensureAgentRecovery()
    await agentLaunchLifecycle.pause()
    await this.recoverBackgroundAgents()
    this.automationScheduler?.stop()
    await Promise.all([
      this.stopTerminalAgents(),
      this.managedProcesses.stopAll(),
      this.notebookServers.stopAll(),
      stopRunningRenders(),
    ])
    await Promise.all([...this.processFinalizers])
    // Bounded: a missing or late daemon confirmation warns and the stop goes on.
    await this.terminalSupervisor.shutdownDaemon(3_000, (message) => console.warn(message))
  }

  /** Daemon session ids of PI Lab agents and planning sessions that have not exited. */
  private async agentSessionIds(): Promise<Set<string>> {
    const rows = getDb()
      .select({ sessionId: agentSessions.sessionId })
      .from(agentSessions)
      .where(ne(agentSessions.state, "exited"))
      .all()
    const planning = await listPlanningAgentSessions()
    return new Set([...rows, ...planning].map((row) => row.sessionId))
  }

  /** Only PI Lab agent sessions are affected; ordinary shells and Python runs are separate. */
  private async liveTerminalAgents() {
    const ids = await this.agentSessionIds()
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
    throw new Error("Some agents did not stop")
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
        console.error("[pi-lab server] background agent result could not be saved", error)
      })
  }

  /** Close process-owned services when the server exits. */
  dispose(): void {
    this.automationScheduler?.stop()
    this.caffeineController?.dispose()
    this.dictation?.dispose()
    this.activityMonitor?.dispose()
    this.notifications.dispose()
    this.activityRegistry.dispose()
    this.managedProcesses.dispose()
    this.terminalSupervisor.dispose()
    this.analysisInteractive.dispose()
    this.analysisPreview.dispose()
    analysisMedia.clear()
    this.notebookServers.dispose()
  }

  private startAutomationScheduler(): void {
    if (this.automationScheduler) return
    const testInterval = isTestMode
      ? Number(process.env.PI_LAB_TEST_SCHEDULER_INTERVAL_MS ?? "")
      : Number.NaN
    this.automationScheduler = new AutomationScheduler({
      db: getDb(),
      fire: (args) => dispatchAutomation(this.createAppContext(), args),
      ...(Number.isFinite(testInterval) && testInterval > 0 ? { intervalMs: testInterval } : {}),
    })
    this.automationScheduler.start()
  }

  /** The router context for one request: every service, no Electron. */
  createAppContext(): AppContext {
    if (!this.activityStatus) throw new Error("activity status is not initialized")
    if (!this.activityMonitor) throw new Error("activity monitor is not initialized")
    if (!this.caffeineController) throw new Error("caffeine controller is not initialized")
    const resources = this.config.resourcesDir
    return {
      db: getDb(),
      appChannel: this.config.channel,
      skillsHomeDir: skillsHomeDirOverride ?? homedir(),
      userDataDir: this.config.dataDir,
      latexResourcesDir: join(resources, "latex"),
      latexCacheDir: tectonicCacheDir(
        isTestMode,
        this.config.dataDir,
        process.platform,
        homedir(),
        process.env,
      ),
      dictation: this.dictation ?? undefined,
      bundledSkillsDir: join(resources, "skills"),
      getDaemonClient: () => this.terminalSupervisor.ensureClient(),
      agentCatalog: this.agentCatalog,
      resolveAgentExecutable: DEFAULT_AGENT_EXECUTABLE_RESOLVER,
      getAgentLaunchEnvironment: async () => {
        await this.ensureAgentRecovery()
        return DEFAULT_AGENT_LAUNCH_ENVIRONMENT()
      },
      runNonInteractiveProcess: this.managedProcesses.run,
      setupProbe: isTestMode ? testSetupProbe : DEFAULT_SETUP_PROBE,
      credentialCipher: this.secrets,
      sshExec: DEFAULT_SSH_EXEC,
      httpFetch: DEFAULT_HTTP_FETCH,
      openPath: async () => clientOnly("Opening a file with its default app"),
      revealPath: () => clientOnly("Showing a file in Finder"),
      trashPath,
      writeClipboard: () => clientOnly("Copying to the clipboard"),
      thumbnailImageProcessor: nodeThumbnailImageProcessor,
      pyToolsExec: DEFAULT_PY_TOOLS_EXEC,
      discoverPythonEnvironments: DEFAULT_PYTHON_ENVIRONMENT_DISCOVERER,
      resolvePythonRuntime: DEFAULT_PYTHON_RUNTIME_RESOLVER,
      analysisInteractive: this.analysisInteractive,
      analysisPreview: this.analysisPreview,
      notebookServers: this.notebookServers,
      notifications: this.notificationBrokers,
      activityStatus: this.activityStatus,
      activityMonitor: this.activityMonitor,
      notificationService: this.notifications,
      caffeine: this.caffeineController,
    }
  }
}

/** The dictation catalog; test mode can re-pin model sizes and digests for e2e downloads. */
function dictationCatalog(): readonly DictationModel[] {
  const pins = isTestMode ? process.env.PI_LAB_TEST_DICTATION_PINS?.trim() : undefined
  return pins ? withTestPins(DICTATION_MODELS, pins) : DICTATION_MODELS
}
