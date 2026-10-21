import {
  type AgentSession,
  type AutomationRun,
  agentSessions,
  automationRuns,
  type PiLabDatabase,
} from "@pi-lab/local-db"
import type { AttachResult, DataEvent, ExitEvent, SessionInfo } from "@pi-lab/pty-daemon"
import { eq, ne } from "drizzle-orm"
import { nativeNotificationBody, nativeText } from "../i18n/nativeLanguage"
import type { NotificationService } from "../notifications"
import type { ActivityRegistry } from "./registry"
import {
  createHeadlessRenderedTerminal,
  type RenderedTerminal,
  type RenderedTerminalFactory,
} from "./renderedTerminal"
import type {
  ActivityClock,
  ActivityRegistryChange,
  ActivityScheduler,
  ActivityTimer,
  AgentActivityRecord,
  RegisterAgentActivity,
  WorkflowRunActivityState,
} from "./types"

export interface ActivityDaemonClient {
  attach: (sessionId: string, onReplay?: (result: AttachResult) => void) => Promise<AttachResult>
  list: () => Promise<SessionInfo[]>
  on: {
    (event: "data", listener: (event: DataEvent) => void): unknown
    (event: "exit", listener: (event: ExitEvent) => void): unknown
    (event: "close", listener: () => void): unknown
  }
}

export interface TrackAgentSession extends RegisterAgentActivity {
  cols: number
  rows: number
}

export interface TrackTerminalSession {
  sessionId: string
  projectId: string
  workspaceId: string
  label: string
  cols: number
  rows: number
}

export interface ActivityMonitorPort {
  track: (input: TrackAgentSession) => Promise<void>
  trackTerminal: (input: TrackTerminalSession) => Promise<void>
  reconcile: () => Promise<void>
  liveAgentCount: (projectId: string) => number
  userInput: (sessionId: string, data: string) => void
  resize: (sessionId: string, cols: number, rows: number) => void
  dispose: () => void
}

export interface ActivityMonitorOptions {
  db: PiLabDatabase
  registry: ActivityRegistry
  getMonitorClient: () => Promise<ActivityDaemonClient>
  notifications: NotificationService
  scheduler: ActivityScheduler
  clock?: ActivityClock
  terminalFactory: RenderedTerminalFactory
  logger: Pick<Console, "warn">
}

interface MonitoredTerminal {
  terminal: RenderedTerminal
  cols: number
  rows: number
  kind: "agent" | "terminal"
  replayPending: boolean
}

interface TerminalCommandRuntime {
  projectId: string
  workspaceId: string
  label: string
  inputBuffer: string
  promptLine: string | null
  currentLine: string
  lastScreen: string
  baselineScreen: string
  submittedCommand: string | null
  commandPending: boolean
  outputObserved: boolean
  completionTimer: ActivityTimer | null
}

type AgentDurableFields = Pick<
  AgentSession,
  "state" | "turnArmed" | "waitingReason" | "waitingSince" | "exitedAt" | "updatedAt"
>

interface WorkflowDurableFields {
  state: WorkflowRunActivityState
  sessionId: string | null
  workspaceId: string | null
  launchedAt: number | null
  completedAt: number | null
  error: string | null
}

/** Select only fields written to the agent session row. */
function agentDurableFields(record: AgentActivityRecord | AgentSession): AgentDurableFields {
  return {
    state: record.state,
    turnArmed: record.turnArmed,
    waitingReason: record.waitingReason,
    waitingSince: record.waitingSince,
    exitedAt: record.exitedAt,
    updatedAt: record.updatedAt,
  }
}

const RECONNECT_DELAY_MS = 1_000
const ACTIVITY_TIMESTAMP_WRITE_DELAY_MS = 1_000
export const TERMINAL_COMPLETION_CONFIRMATION_MS = 1_000
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal input can contain ANSI escape sequences.
const TERMINAL_ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: control bytes are expected in raw terminal input.
const TERMINAL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g

export class ActivityMonitor implements ActivityMonitorPort {
  private readonly terminals = new Map<string, MonitoredTerminal>()
  private readonly terminalCommands = new Map<string, TerminalCommandRuntime>()
  private readonly clients = new WeakSet<object>()
  private readonly previous = new Map<string, AgentActivityRecord>()
  private readonly persistedAgents = new Map<string, AgentDurableFields>()
  private readonly persistedWorkflows = new Map<string, WorkflowDurableFields>()
  private readonly notificationOnlyTimestamps = new Map<string, number>()
  private readonly pendingAgentTimestamps = new Map<
    string,
    { record: AgentActivityRecord; timer: ActivityTimer }
  >()
  private readonly unsubscribeRegistry: () => void
  private reconnectTimer: { cancel(): void } | null = null
  private disposed = false

  constructor(private readonly options: ActivityMonitorOptions) {
    this.unsubscribeRegistry = options.registry.subscribe((change) =>
      this.handleRegistryChange(change),
    )
  }

  async track(input: TrackAgentSession): Promise<void> {
    const at = this.options.clock?.now() ?? Date.now()
    this.options.db
      .insert(agentSessions)
      .values({
        sessionId: input.sessionId,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        workflowRunId: input.workflowRunId,
        state: "working",
        turnArmed: input.turnArmed,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: agentSessions.sessionId,
        set: {
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          workflowRunId: input.workflowRunId,
          state: "working",
          turnArmed: input.turnArmed,
          waitingReason: null,
          waitingSince: null,
          exitedAt: null,
          updatedAt: at,
        },
      })
      .run()

    this.options.registry.register(input)
    if (input.workflowRunId) this.options.registry.markWorkflowRunning(input.sessionId)
    await this.attach(input.sessionId, input.cols, input.rows, "agent")
  }

  async trackTerminal(input: TrackTerminalSession): Promise<void> {
    if (this.terminalCommands.has(input.sessionId)) return
    this.terminalCommands.set(input.sessionId, {
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      label: input.label,
      inputBuffer: "",
      promptLine: null,
      currentLine: "",
      lastScreen: "",
      baselineScreen: "",
      submittedCommand: null,
      commandPending: false,
      outputObserved: false,
      completionTimer: null,
    })
    await this.attach(input.sessionId, input.cols, input.rows, "terminal")
  }

  async reconcile(): Promise<void> {
    if (this.disposed) return
    const durable = this.options.db
      .select()
      .from(agentSessions)
      .where(ne(agentSessions.state, "exited"))
      .all()
    if (durable.length === 0 && this.terminalCommands.size === 0) return
    const client = await this.options.getMonitorClient()
    this.wireClient(client)
    const daemonSessions = new Map((await client.list()).map((session) => [session.id, session]))

    for (const row of durable) {
      const daemonSession = daemonSessions.get(row.sessionId)
      const restored = this.toActivityRecord(row)
      this.options.registry.restore(restored)
      if (!daemonSession?.alive) {
        this.options.registry.processExited(row.sessionId, "Session was not live after restart")
        continue
      }
      await this.attach(row.sessionId, daemonSession.cols, daemonSession.rows, "agent", client)
    }

    for (const sessionId of this.terminalCommands.keys()) {
      const daemonSession = daemonSessions.get(sessionId)
      if (!daemonSession?.alive) {
        this.forgetTerminal(sessionId)
        continue
      }
      await this.attach(sessionId, daemonSession.cols, daemonSession.rows, "terminal", client)
    }
  }

  userInput(sessionId: string, data: string): void {
    const terminal = this.terminalCommands.get(sessionId)
    if (terminal) {
      this.observeTerminalInput(terminal, data)
      return
    }
    if (data.includes("\r")) {
      this.options.registry.userSubmitted(sessionId)
    }
  }

  liveAgentCount(projectId: string): number {
    return this.options.registry
      .snapshot()
      .sessions.filter((session) => session.projectId === projectId && session.state !== "exited")
      .length
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const monitored = this.terminals.get(sessionId)
    if (!monitored) return
    monitored.cols = cols
    monitored.rows = rows
    monitored.terminal.resize(cols, rows)
  }

  dispose(): void {
    this.disposed = true
    this.reconnectTimer?.cancel()
    this.reconnectTimer = null
    for (const sessionId of this.pendingAgentTimestamps.keys()) this.flushAgentTimestamp(sessionId)
    this.unsubscribeRegistry()
    for (const monitored of this.terminals.values()) monitored.terminal.dispose()
    this.terminals.clear()
    for (const terminal of this.terminalCommands.values()) terminal.completionTimer?.cancel()
    this.terminalCommands.clear()
  }

  private async attach(
    sessionId: string,
    cols: number,
    rows: number,
    kind: "agent" | "terminal",
    providedClient?: ActivityDaemonClient,
  ): Promise<void> {
    if (this.disposed || this.terminals.has(sessionId)) return
    const client = providedClient ?? (await this.options.getMonitorClient())
    this.wireClient(client)
    const terminal = this.options.terminalFactory(cols, rows)
    const monitored = { terminal, cols, rows, kind, replayPending: true }
    this.terminals.set(sessionId, monitored)
    const replay = (result: AttachResult) => {
      if (!monitored.replayPending || this.terminals.get(sessionId) !== monitored) return
      monitored.replayPending = false
      if (!result.session.alive) {
        this.handleExit({
          kind: "exit",
          sessionId,
          exitCode: null,
          signal: null,
        })
        return
      }
      if (result.scrollback.length > 0) this.render(sessionId, result.scrollback)
    }
    try {
      const result = await client.attach(sessionId, replay)
      // Keep injected clients that only return a snapshot compatible with the port.
      replay(result)
    } catch (error) {
      terminal.dispose()
      this.terminals.delete(sessionId)
      if (kind === "agent") {
        this.options.registry.processExited(
          sessionId,
          error instanceof Error ? error.message : String(error),
        )
      } else {
        this.forgetTerminal(sessionId)
      }
      this.options.logger.warn(
        `[pi-lab] failed to monitor agent session ${sessionId}: ${String(error)}`,
      )
    }
  }

  private wireClient(client: ActivityDaemonClient): void {
    const identity = client as object
    if (this.clients.has(identity)) return
    this.clients.add(identity)
    client.on("data", (event) => {
      if (!this.terminals.get(event.sessionId)?.replayPending)
        this.render(event.sessionId, event.chunk)
    })
    client.on("exit", (event) => this.handleExit(event))
    client.on("close", () => this.handleClientClose())
  }

  private render(sessionId: string, chunk: string): void {
    const monitored = this.terminals.get(sessionId)
    if (!monitored) return
    monitored.terminal.write(chunk, () => {
      if (!this.terminals.has(sessionId)) return
      const screen = monitored.terminal.screen()
      if (monitored.kind === "agent") {
        this.options.registry.observeRenderedScreen(sessionId, screen)
      } else {
        this.observeTerminalScreen(sessionId, screen, monitored.terminal.cursorLine())
      }
    })
  }

  private handleExit(event: ExitEvent): void {
    const monitored = this.terminals.get(event.sessionId)
    monitored?.terminal.dispose()
    this.terminals.delete(event.sessionId)
    if (monitored?.kind === "terminal" || this.terminalCommands.has(event.sessionId)) {
      const terminal = this.terminalCommands.get(event.sessionId)
      if (terminal?.commandPending && event.exitCode === 0)
        this.notifyTerminalCompletion(event.sessionId)
      this.forgetTerminal(event.sessionId)
      return
    }
    const description =
      event.signal !== null
        ? `Agent exited from signal ${event.signal}`
        : event.exitCode === 0
          ? null
          : `Agent exited with code ${event.exitCode ?? "unknown"}`
    this.options.registry.processExited(event.sessionId, description)
  }

  private handleClientClose(): void {
    if (this.disposed) return
    for (const monitored of this.terminals.values()) monitored.terminal.dispose()
    this.terminals.clear()
    this.reconnectTimer?.cancel()
    this.reconnectTimer = this.options.scheduler.schedule(RECONNECT_DELAY_MS, () => {
      this.reconnectTimer = null
      void this.reconcile().catch((error) => {
        this.options.logger.warn(`[pi-lab] activity monitor reconnect failed: ${String(error)}`)
        this.handleClientClose()
      })
    })
  }

  private observeTerminalInput(runtime: TerminalCommandRuntime, data: string): void {
    for (const character of data) {
      if (character === "\u0003") {
        runtime.inputBuffer = ""
        continue
      }
      if (character === "\u007f" || character === "\b") {
        runtime.inputBuffer = runtime.inputBuffer.slice(0, -1)
        continue
      }
      if (character === "\n") {
        runtime.inputBuffer += character
        continue
      }
      if (character !== "\r") {
        if (character >= " ") runtime.inputBuffer += character
        continue
      }

      const command = cleanTerminalCommand(runtime.inputBuffer)
      runtime.inputBuffer = ""
      if (!command) continue
      runtime.completionTimer?.cancel()
      runtime.completionTimer = null
      runtime.submittedCommand = command
      runtime.commandPending = true
      runtime.outputObserved = false
      runtime.baselineScreen = runtime.lastScreen
    }
  }

  private observeTerminalScreen(sessionId: string, rawScreen: string, rawCursorLine: string): void {
    const runtime = this.terminalCommands.get(sessionId)
    if (!runtime) return
    const screen = normalizeTerminalScreen(rawScreen)
    const cursorLine = normalizeTerminalLine(rawCursorLine)
    runtime.currentLine = cursorLine

    if (!runtime.commandPending) {
      runtime.lastScreen = screen
      if (cursorLine && isLikelyShellPrompt(cursorLine)) runtime.promptLine = cursorLine
      return
    }

    if (screen !== runtime.baselineScreen) runtime.outputObserved = true
    runtime.lastScreen = screen
    const returnedToPrompt =
      runtime.outputObserved &&
      cursorLine.length > 0 &&
      isReturnedShellPrompt(cursorLine, runtime.promptLine, runtime.submittedCommand)

    if (!returnedToPrompt) {
      runtime.completionTimer?.cancel()
      runtime.completionTimer = null
      return
    }
    if (runtime.completionTimer) return
    runtime.completionTimer = this.options.scheduler.schedule(
      TERMINAL_COMPLETION_CONFIRMATION_MS,
      () => {
        const current = this.terminalCommands.get(sessionId)
        if (!current?.commandPending) return
        current.completionTimer = null
        if (
          !current.outputObserved ||
          !current.currentLine ||
          !isReturnedShellPrompt(current.currentLine, current.promptLine, current.submittedCommand)
        ) {
          return
        }
        current.promptLine = current.currentLine
        this.notifyTerminalCompletion(sessionId)
      },
    )
  }

  private notifyTerminalCompletion(sessionId: string): void {
    const runtime = this.terminalCommands.get(sessionId)
    if (!runtime?.commandPending) return
    runtime.completionTimer?.cancel()
    runtime.completionTimer = null
    runtime.submittedCommand = null
    runtime.commandPending = false
    runtime.outputObserved = false
    runtime.baselineScreen = runtime.lastScreen
    this.options.notifications.notify({
      eventType: "terminalCompletion",
      title: nativeText("Terminal command finished"),
      body: nativeNotificationBody("terminalReady", runtime.label),
      target: {
        type: "terminal",
        projectId: runtime.projectId,
        workspaceId: runtime.workspaceId,
        sessionId,
        label: runtime.label,
      },
    })
  }

  private forgetTerminal(sessionId: string): void {
    const runtime = this.terminalCommands.get(sessionId)
    runtime?.completionTimer?.cancel()
    this.terminalCommands.delete(sessionId)
  }

  private handleRegistryChange(change: ActivityRegistryChange): void {
    for (const record of change.snapshot.sessions) {
      const prior = this.previous.get(record.sessionId)
      this.previous.set(record.sessionId, { ...record })
      this.persistAgent(record, prior)
      if (record.workflowRunId) this.persistWorkflow(record)

      if (
        record.state === "waiting" &&
        (prior?.state !== "waiting" || prior.waitingEpisode !== record.waitingEpisode)
      ) {
        if (record.waitingReason !== "initial-prompt") {
          const claimed = this.options.registry.claimWaitingNotification(record.sessionId)
          if (claimed?.waitingReason === "turn-complete") {
            const isInitialWorkflowCompletion =
              prior?.workflowState === "running" && claimed.workflowState === "completed"
            if (!isInitialWorkflowCompletion) this.notifyAgentTurnCompletion(claimed)
          } else if (claimed) {
            this.notifyAgentWaiting(claimed)
          }
        }
      }

      if (!prior || prior.workflowState === record.workflowState || !record.workflowRunId) continue
      if (record.workflowState === "running") this.notifyWorkflow(record, "workflowStart")
      if (record.workflowState === "completed") this.notifyWorkflow(record, "workflowCompletion")
      if (record.workflowState === "failed") this.notifyWorkflow(record, "workflowFailure")
    }
    for (const record of change.snapshot.sessions) {
      if (record.state !== "exited") continue
      this.pendingAgentTimestamps.get(record.sessionId)?.timer.cancel()
      this.pendingAgentTimestamps.delete(record.sessionId)
      this.previous.delete(record.sessionId)
      this.persistedAgents.delete(record.sessionId)
      this.notificationOnlyTimestamps.delete(record.sessionId)
      if (record.workflowRunId) this.persistedWorkflows.delete(record.workflowRunId)
      this.terminals.get(record.sessionId)?.terminal.dispose()
      this.terminals.delete(record.sessionId)
      this.options.registry.retireExited(record.sessionId)
    }
  }

  private persistAgent(
    record: AgentActivityRecord,
    previous: AgentActivityRecord | undefined,
  ): void {
    const prior =
      this.persistedAgents.get(record.sessionId) ?? this.loadPersistedAgent(record.sessionId)
    if (!prior) return
    const next = agentDurableFields(record)
    const changed: Partial<AgentDurableFields> = {}
    if (next.state !== prior.state) changed.state = next.state
    if (next.turnArmed !== prior.turnArmed) changed.turnArmed = next.turnArmed
    if (next.waitingReason !== prior.waitingReason) changed.waitingReason = next.waitingReason
    if (next.waitingSince !== prior.waitingSince) changed.waitingSince = next.waitingSince
    if (next.exitedAt !== prior.exitedAt) changed.exitedAt = next.exitedAt
    if (next.updatedAt !== prior.updatedAt) changed.updatedAt = next.updatedAt
    if (Object.keys(changed).length === 0) return
    if (
      Object.keys(changed).length === 1 &&
      changed.updatedAt !== undefined &&
      previous !== undefined &&
      previous.waitingNotifiedEpisode !== record.waitingNotifiedEpisode
    ) {
      this.notificationOnlyTimestamps.set(record.sessionId, record.updatedAt)
      return
    }
    if (
      Object.keys(changed).length === 1 &&
      this.notificationOnlyTimestamps.get(record.sessionId) === record.updatedAt
    ) {
      return
    }
    this.notificationOnlyTimestamps.delete(record.sessionId)
    if (Object.keys(changed).some((key) => key !== "updatedAt")) {
      this.pendingAgentTimestamps.get(record.sessionId)?.timer.cancel()
      this.pendingAgentTimestamps.delete(record.sessionId)
      this.writeAgentFields(record.sessionId, changed, next)
      return
    }
    const pending = this.pendingAgentTimestamps.get(record.sessionId)
    if (pending) {
      pending.record = record
      return
    }
    const timer = this.options.scheduler.schedule(ACTIVITY_TIMESTAMP_WRITE_DELAY_MS, () =>
      this.flushAgentTimestamp(record.sessionId),
    )
    this.pendingAgentTimestamps.set(record.sessionId, { record, timer })
  }

  /** Write the latest routine timestamp when its one-second window closes. */
  private flushAgentTimestamp(sessionId: string): void {
    const pending = this.pendingAgentTimestamps.get(sessionId)
    if (!pending) return
    pending.timer.cancel()
    this.pendingAgentTimestamps.delete(sessionId)
    const prior = this.persistedAgents.get(sessionId)
    const next = agentDurableFields(pending.record)
    if (!prior || prior.updatedAt === next.updatedAt) return
    this.writeAgentFields(sessionId, { updatedAt: next.updatedAt }, next)
  }

  /** Read one durable baseline so registry publications do not rewrite an unchanged row. */
  private loadPersistedAgent(sessionId: string): AgentDurableFields | null {
    const row = this.options.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.sessionId, sessionId))
      .get()
    if (!row) return null
    const fields = agentDurableFields(row)
    this.persistedAgents.set(sessionId, fields)
    return fields
  }

  private writeAgentFields(
    sessionId: string,
    changed: Partial<AgentDurableFields>,
    next: AgentDurableFields,
  ): void {
    this.options.db
      .update(agentSessions)
      .set(changed)
      .where(eq(agentSessions.sessionId, sessionId))
      .run()
    this.persistedAgents.set(sessionId, next)
  }

  private persistWorkflow(record: AgentActivityRecord): void {
    if (!record.workflowRunId || !record.workflowState) return
    const prior =
      this.persistedWorkflows.get(record.workflowRunId) ??
      this.loadPersistedWorkflow(record.workflowRunId)
    if (!prior) return
    const next: WorkflowDurableFields = {
      state: record.workflowState,
      sessionId: record.sessionId,
      workspaceId: record.workspaceId,
      launchedAt:
        prior.state === "pending" && record.workflowState === "running" && prior.launchedAt === null
          ? record.updatedAt
          : prior.launchedAt,
      completedAt: record.workflowCompletedAt,
      error: record.workflowFailureReason,
    }
    const changed: Partial<WorkflowDurableFields> = {}
    if (next.state !== prior.state) changed.state = next.state
    if (next.sessionId !== prior.sessionId) changed.sessionId = next.sessionId
    if (next.workspaceId !== prior.workspaceId) changed.workspaceId = next.workspaceId
    if (next.launchedAt !== prior.launchedAt) changed.launchedAt = next.launchedAt
    if (next.completedAt !== prior.completedAt) changed.completedAt = next.completedAt
    if (next.error !== prior.error) changed.error = next.error
    if (Object.keys(changed).length === 0) return
    this.options.db
      .update(automationRuns)
      .set(changed)
      .where(eq(automationRuns.id, record.workflowRunId))
      .run()
    this.persistedWorkflows.set(record.workflowRunId, next)
  }

  private loadPersistedWorkflow(runId: string): WorkflowDurableFields | null {
    const row = this.options.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, runId))
      .get()
    if (!row) return null
    const fields: WorkflowDurableFields = {
      state: workflowState(row) ?? "pending",
      sessionId: row.sessionId,
      workspaceId: row.workspaceId,
      launchedAt: row.launchedAt,
      completedAt: row.completedAt,
      error: row.error,
    }
    this.persistedWorkflows.set(runId, fields)
    return fields
  }

  private notifyAgentWaiting(record: AgentActivityRecord): void {
    if (!record.workspaceId) return
    this.options.notifications.notify({
      eventType: "agentInput",
      title: nativeText("Agent needs input"),
      body: nativeNotificationBody("agentWaiting", record.agentId, waitingLabel(record)),
      target: {
        type: "agent",
        projectId: record.projectId,
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        agentId: record.agentId,
      },
    })
  }

  private notifyAgentTurnCompletion(record: AgentActivityRecord): void {
    if (!record.workspaceId) return
    this.options.notifications.notify({
      eventType: "agentTurnCompletion",
      title: nativeText("Agent finished its turn"),
      body: nativeNotificationBody("agentReady", record.agentId),
      target: {
        type: "agent",
        projectId: record.projectId,
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        agentId: record.agentId,
      },
    })
  }

  private notifyWorkflow(
    record: AgentActivityRecord,
    eventType: "workflowStart" | "workflowCompletion" | "workflowFailure",
  ): void {
    if (!record.workflowRunId) return
    const run = this.options.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, record.workflowRunId))
      .get()
    if (!run) return
    const title =
      eventType === "workflowStart"
        ? nativeText("Workflow started")
        : eventType === "workflowCompletion"
          ? nativeText("Workflow completed")
          : nativeText("Workflow failed")
    this.options.notifications.notify({
      eventType,
      title,
      body: workflowBody(run, record),
      target: { type: "workflow", workflowId: run.automationId, runId: run.id },
    })
  }

  private toActivityRecord(row: AgentSession): AgentActivityRecord {
    const workflow = row.workflowRunId
      ? this.options.db
          .select()
          .from(automationRuns)
          .where(eq(automationRuns.id, row.workflowRunId))
          .get()
      : null
    return {
      sessionId: row.sessionId,
      projectId: row.projectId,
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      workflowRunId: row.workflowRunId,
      state: row.state,
      waitingReason: row.waitingReason,
      waitingSince: row.waitingSince,
      waitingEpisode: row.state === "waiting" ? 1 : 0,
      waitingNotifiedEpisode: row.state === "waiting" ? 1 : null,
      turnArmed: row.turnArmed,
      workflowState: workflowState(workflow),
      workflowCompletedAt: workflow?.completedAt ?? null,
      workflowFailureReason: workflow?.error ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastQualifyingOutputAt: null,
      exitedAt: row.exitedAt,
    }
  }
}

export function createActivityMonitor(
  options: Omit<ActivityMonitorOptions, "terminalFactory">,
): ActivityMonitor {
  return new ActivityMonitor({ ...options, terminalFactory: createHeadlessRenderedTerminal })
}

function workflowState(run: AutomationRun | null | undefined): WorkflowRunActivityState | null {
  if (!run) return null
  if (run.state === "launched") return "completed"
  return run.state
}

function waitingLabel(
  record: AgentActivityRecord,
): "permission" | "an answer" | "your next instruction" {
  if (record.waitingReason === "permission") return "permission"
  if (record.waitingReason === "question") return "an answer"
  return "your next instruction"
}

function workflowBody(run: AutomationRun, record: AgentActivityRecord): string {
  if (record.workflowState === "failed") {
    return record.workflowFailureReason ?? `Run ${run.id} failed`
  }
  return `Run ${run.id}`
}

function normalizeTerminalScreen(screen: string): string {
  return screen
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
}

function normalizeTerminalLine(line: string): string {
  return line.replaceAll("\r", "").trim()
}

function isLikelyShellPrompt(line: string): boolean {
  if (line.length > 200) return false
  return /^(?:➜|❯|λ)\s+/u.test(line) || /(?:^|\s)[^\n]*[$%#❯›>]\s*$/u.test(line)
}

function isReturnedShellPrompt(
  line: string,
  knownPrompt: string | null,
  submittedCommand: string | null,
): boolean {
  if (!knownPrompt) return isLikelyShellPrompt(line)
  if (line === knownPrompt) return true
  if (
    submittedCommand &&
    line.startsWith(knownPrompt) &&
    line.slice(knownPrompt.length).trim() === submittedCommand
  ) {
    return false
  }
  const knownPrefix = knownPrompt.match(/^(?:➜|❯|λ)\s+/u)?.[0]
  if (knownPrefix) return line.startsWith(knownPrefix)
  const knownSuffix = knownPrompt.match(/[$%#❯›>]\s*$/u)?.[0]
  return knownSuffix ? line.endsWith(knownSuffix) && isLikelyShellPrompt(line) : false
}

function cleanTerminalCommand(input: string): string {
  return input.replace(TERMINAL_ANSI_ESCAPE, "").replace(TERMINAL_CONTROL_CHARACTERS, "").trim()
}
