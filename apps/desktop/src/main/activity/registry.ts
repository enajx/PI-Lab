import { classifyRenderedAgentScreen } from "./classifyScreen"
import {
  type ActivityClock,
  type ActivityEvent,
  type ActivityRegistryChange,
  type ActivityRegistryListener,
  type ActivityRegistrySnapshot,
  type ActivityScheduler,
  type ActivityTimer,
  type AgentActivityRecord,
  IDLE_FALLBACK_MS,
  type RegisterAgentActivity,
  type ScreenClassification,
  WAITING_CONFIRMATION_MS,
  type WaitingReason,
} from "./types"

interface WaitingCandidate {
  reason: Exclude<WaitingReason, "idle">
  fingerprint: string
  observedAt: number
  timer: ActivityTimer
}

interface SessionRuntime {
  candidate: WaitingCandidate | null
  idleTimer: ActivityTimer | null
  lastScreenFingerprint: string | null
}

export interface ActivityRegistryDependencies {
  clock: ActivityClock
  scheduler: ActivityScheduler
}

function cloneRecord(record: AgentActivityRecord): AgentActivityRecord {
  return { ...record }
}

/**
 * App-lifetime source of truth for interactive agent and workflow activity.
 *
 * The registry receives rendered-screen observations from a monitor connection.
 * It owns confirmation/idle timers, notification episode deduplication, and an
 * acquire/working/release/idle event stream consumed by notifications and Auto
 * caffeine. It deliberately owns neither PTYs nor persistence.
 */
export class ActivityRegistry {
  private readonly sessions = new Map<string, AgentActivityRecord>()
  private readonly runtime = new Map<string, SessionRuntime>()
  private readonly listeners = new Set<ActivityRegistryListener>()
  private readonly pendingRetirements = new Set<string>()
  private publicationDepth = 0
  private readonly clock: ActivityClock
  private readonly scheduler: ActivityScheduler

  constructor(dependencies: ActivityRegistryDependencies) {
    this.clock = dependencies.clock
    this.scheduler = dependencies.scheduler
  }

  subscribe(listener: ActivityRegistryListener): () => void {
    this.listeners.add(listener)
    listener({ snapshot: this.snapshot(), activityEvents: [] })
    return () => {
      this.listeners.delete(listener)
    }
  }

  snapshot(): ActivityRegistrySnapshot {
    const sessions = [...this.sessions.values()]
      .map(cloneRecord)
      .sort((left, right) => left.createdAt - right.createdAt)
    const workingSessionIds = sessions
      .filter((session) => session.state === "working")
      .map((session) => session.sessionId)
    return {
      sessions,
      workingSessionIds,
      hasWorkingActivity: workingSessionIds.length > 0,
    }
  }

  get(sessionId: string): AgentActivityRecord | null {
    const record = this.sessions.get(sessionId)
    return record ? cloneRecord(record) : null
  }

  /** Retire in-memory history after every listener has received the final events. */
  retireExited(sessionId: string): void {
    this.pendingRetirements.add(sessionId)
    if (this.publicationDepth === 0) this.flushRetirements()
  }

  register(input: RegisterAgentActivity): AgentActivityRecord {
    const existing = this.sessions.get(input.sessionId)
    if (existing) return cloneRecord(existing)

    const at = this.clock.now()
    const record: AgentActivityRecord = {
      ...input,
      state: "working",
      waitingReason: null,
      waitingSince: null,
      waitingEpisode: 0,
      waitingNotifiedEpisode: null,
      workflowState: input.workflowRunId ? "pending" : null,
      workflowCompletedAt: null,
      workflowFailureReason: null,
      createdAt: at,
      updatedAt: at,
      lastQualifyingOutputAt: null,
      exitedAt: null,
    }
    this.sessions.set(input.sessionId, record)
    this.runtime.set(input.sessionId, {
      candidate: null,
      idleTimer: null,
      lastScreenFingerprint: null,
    })
    this.publish([{ phase: "acquire", sessionId: input.sessionId, at }])
    return cloneRecord(record)
  }

  /**
   * Rehydrate a durable record during daemon reconciliation. The monitor retires
   * persisted exits; a recovered working record reacquires app activity.
   */
  restore(record: AgentActivityRecord): AgentActivityRecord {
    const existing = this.sessions.get(record.sessionId)
    if (existing) return cloneRecord(existing)
    const restored = cloneRecord(record)
    this.sessions.set(restored.sessionId, restored)
    const runtime: SessionRuntime = {
      candidate: null,
      idleTimer: null,
      lastScreenFingerprint: null,
    }
    this.runtime.set(restored.sessionId, runtime)
    if (restored.state === "working") {
      this.publish([{ phase: "acquire", sessionId: restored.sessionId, at: this.clock.now() }])
      this.scheduleRestoredIdleFallback(restored, runtime)
    } else {
      this.publish([])
    }
    return cloneRecord(restored)
  }

  markWorkflowRunning(sessionId: string): AgentActivityRecord | null {
    const record = this.sessions.get(sessionId)
    if (record?.workflowState !== "pending") return record ? cloneRecord(record) : null
    const at = this.clock.now()
    record.workflowState = "running"
    record.updatedAt = at
    this.publish([])
    return cloneRecord(record)
  }

  failLaunch(sessionId: string, reason: string): AgentActivityRecord | null {
    const record = this.sessions.get(sessionId)
    if (!record) return null
    const at = this.clock.now()
    if (record.workflowState === "pending") {
      record.workflowState = "failed"
      record.workflowFailureReason = reason
      record.workflowCompletedAt = at
    }
    this.transitionToExited(record, at)
    return cloneRecord(record)
  }

  userSubmitted(sessionId: string): AgentActivityRecord | null {
    const record = this.sessions.get(sessionId)
    if (!record || record.state === "exited") return record ? cloneRecord(record) : null
    const runtime = this.requireRuntime(sessionId)
    this.cancelWaitingCandidate(runtime)
    this.cancelIdleTimer(runtime)
    runtime.lastScreenFingerprint = null
    record.turnArmed = true
    this.transitionToWorking(record, this.clock.now())
    return cloneRecord(record)
  }

  observeRenderedScreen(sessionId: string, screen: string): ScreenClassification | null {
    const record = this.sessions.get(sessionId)
    if (!record || record.state === "exited") return null
    const classification = classifyRenderedAgentScreen(screen)
    this.applyClassification(record, classification)
    return classification
  }

  processExited(sessionId: string, exitDescription: string | null): AgentActivityRecord | null {
    const record = this.sessions.get(sessionId)
    if (!record) return null
    const at = this.clock.now()
    if (record.workflowState === "pending" || record.workflowState === "running") {
      record.workflowState = "failed"
      record.workflowFailureReason = exitDescription ?? "Agent exited before workflow completion"
      record.workflowCompletedAt = at
    }
    this.transitionToExited(record, at)
    return cloneRecord(record)
  }

  /**
   * Atomically claim one waiting notification. Repeated calls during the same
   * waiting episode return null; resumed work/user input rearms the next episode.
   */
  claimWaitingNotification(sessionId: string): AgentActivityRecord | null {
    const record = this.sessions.get(sessionId)
    if (
      record?.state !== "waiting" ||
      record.waitingReason === "initial-prompt" ||
      record.waitingNotifiedEpisode === record.waitingEpisode
    ) {
      return null
    }
    record.waitingNotifiedEpisode = record.waitingEpisode
    record.updatedAt = this.clock.now()
    this.publish([])
    return cloneRecord(record)
  }

  dispose(): void {
    for (const runtime of this.runtime.values()) {
      this.cancelWaitingCandidate(runtime)
      this.cancelIdleTimer(runtime)
    }
    this.listeners.clear()
  }

  private applyClassification(
    record: AgentActivityRecord,
    classification: ScreenClassification,
  ): void {
    const runtime = this.requireRuntime(record.sessionId)
    const at = this.clock.now()

    if (classification.kind === "fatal") {
      this.cancelWaitingCandidate(runtime)
      this.cancelIdleTimer(runtime)
      if (record.workflowState === "pending" || record.workflowState === "running") {
        record.workflowState = "failed"
        record.workflowFailureReason = classification.message
        record.workflowCompletedAt = at
      }
      this.transitionToExited(record, at)
      return
    }

    if (
      classification.kind === "permission" ||
      classification.kind === "question" ||
      classification.kind === "normal-prompt"
    ) {
      const reason =
        classification.kind === "normal-prompt"
          ? record.turnArmed
            ? "turn-complete"
            : "initial-prompt"
          : classification.kind
      this.observeWaitingCandidate(record, runtime, reason, classification.fingerprint, at)
      return
    }

    this.cancelWaitingCandidate(runtime)
    if (
      classification.kind === "agent-output" &&
      classification.fingerprint !== runtime.lastScreenFingerprint
    ) {
      runtime.lastScreenFingerprint = classification.fingerprint
      record.lastQualifyingOutputAt = at
      this.transitionToWorking(record, at)
      this.scheduleIdleFallback(record, runtime)
    }
  }

  private observeWaitingCandidate(
    record: AgentActivityRecord,
    runtime: SessionRuntime,
    reason: Exclude<WaitingReason, "idle">,
    fingerprint: string,
    at: number,
  ): void {
    this.cancelIdleTimer(runtime)
    const existing = runtime.candidate
    if (existing?.reason === reason && existing.fingerprint === fingerprint) return
    this.cancelWaitingCandidate(runtime)
    const timer = this.scheduler.schedule(WAITING_CONFIRMATION_MS, () => {
      const currentRecord = this.sessions.get(record.sessionId)
      const currentRuntime = this.runtime.get(record.sessionId)
      if (
        !currentRecord ||
        !currentRuntime ||
        currentRecord.state === "exited" ||
        currentRuntime.candidate?.fingerprint !== fingerprint ||
        currentRuntime.candidate.reason !== reason
      ) {
        return
      }
      currentRuntime.candidate = null
      this.confirmWaiting(currentRecord, reason, this.clock.now())
    })
    runtime.candidate = { reason, fingerprint, observedAt: at, timer }
  }

  private scheduleIdleFallback(record: AgentActivityRecord, runtime: SessionRuntime): void {
    this.cancelIdleTimer(runtime)
    const qualifyingAt = record.lastQualifyingOutputAt
    if (qualifyingAt === null) return
    runtime.idleTimer = this.scheduler.schedule(IDLE_FALLBACK_MS, () => {
      const currentRecord = this.sessions.get(record.sessionId)
      const currentRuntime = this.runtime.get(record.sessionId)
      if (
        !currentRecord ||
        !currentRuntime ||
        currentRecord.state === "exited" ||
        currentRecord.lastQualifyingOutputAt !== qualifyingAt
      ) {
        return
      }
      currentRuntime.idleTimer = null
      this.confirmWaiting(currentRecord, "idle", this.clock.now())
    })
  }

  private scheduleRestoredIdleFallback(record: AgentActivityRecord, runtime: SessionRuntime): void {
    const qualifyingAt = record.lastQualifyingOutputAt
    if (qualifyingAt === null) return
    const elapsed = Math.max(0, this.clock.now() - qualifyingAt)
    const remaining = Math.max(0, IDLE_FALLBACK_MS - elapsed)
    runtime.idleTimer = this.scheduler.schedule(remaining, () => {
      const currentRecord = this.sessions.get(record.sessionId)
      const currentRuntime = this.runtime.get(record.sessionId)
      if (
        !currentRecord ||
        !currentRuntime ||
        currentRecord.state === "exited" ||
        currentRecord.lastQualifyingOutputAt !== qualifyingAt
      ) {
        return
      }
      currentRuntime.idleTimer = null
      this.confirmWaiting(currentRecord, "idle", this.clock.now())
    })
  }

  private confirmWaiting(record: AgentActivityRecord, reason: WaitingReason, at: number): void {
    if (record.state === "waiting" && record.waitingReason === reason) return
    const wasWorking = record.state === "working"
    record.state = "waiting"
    record.waitingReason = reason
    record.waitingSince = at
    record.waitingEpisode += 1
    record.updatedAt = at

    if (reason === "turn-complete") {
      record.turnArmed = false
      if (record.workflowState === "running") {
        record.workflowState = "completed"
        record.workflowCompletedAt = at
      }
    }

    const events: ActivityEvent[] = []
    if (wasWorking) events.push({ phase: "release", sessionId: record.sessionId, at })
    if (!this.hasWorkingSession()) events.push({ phase: "idle", sessionId: null, at })
    this.publish(events)
  }

  private transitionToWorking(record: AgentActivityRecord, at: number): void {
    const wasWorking = record.state === "working"
    record.state = "working"
    record.waitingReason = null
    record.waitingSince = null
    record.updatedAt = at
    this.publish([
      {
        phase: wasWorking ? "working" : "acquire",
        sessionId: record.sessionId,
        at,
      },
    ])
  }

  private transitionToExited(record: AgentActivityRecord, at: number): void {
    if (record.state === "exited") return
    const wasWorking = record.state === "working"
    const runtime = this.requireRuntime(record.sessionId)
    this.cancelWaitingCandidate(runtime)
    this.cancelIdleTimer(runtime)
    record.state = "exited"
    record.waitingReason = null
    record.waitingSince = null
    record.updatedAt = at
    record.exitedAt = at
    const events: ActivityEvent[] = []
    if (wasWorking) events.push({ phase: "release", sessionId: record.sessionId, at })
    if (!this.hasWorkingSession()) events.push({ phase: "idle", sessionId: null, at })
    this.publish(events)
  }

  private hasWorkingSession(): boolean {
    return [...this.sessions.values()].some((record) => record.state === "working")
  }

  private requireRuntime(sessionId: string): SessionRuntime {
    const runtime = this.runtime.get(sessionId)
    if (!runtime) throw new Error(`Missing activity runtime for session ${sessionId}`)
    return runtime
  }

  private cancelWaitingCandidate(runtime: SessionRuntime): void {
    runtime.candidate?.timer.cancel()
    runtime.candidate = null
  }

  private cancelIdleTimer(runtime: SessionRuntime): void {
    runtime.idleTimer?.cancel()
    runtime.idleTimer = null
  }

  private publish(activityEvents: readonly ActivityEvent[]): void {
    if (this.listeners.size === 0) return
    const change: ActivityRegistryChange = {
      snapshot: this.snapshot(),
      activityEvents,
    }
    this.publicationDepth += 1
    try {
      for (const listener of this.listeners) listener(change)
    } finally {
      this.publicationDepth -= 1
      if (this.publicationDepth === 0) this.flushRetirements()
    }
  }

  private flushRetirements(): void {
    for (const sessionId of this.pendingRetirements) {
      if (this.sessions.get(sessionId)?.state !== "exited") continue
      const runtime = this.runtime.get(sessionId)
      if (runtime) {
        this.cancelWaitingCandidate(runtime)
        this.cancelIdleTimer(runtime)
      }
      this.sessions.delete(sessionId)
      this.runtime.delete(sessionId)
    }
    this.pendingRetirements.clear()
  }
}
