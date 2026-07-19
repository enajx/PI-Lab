export const WAITING_CONFIRMATION_MS = 2_000
export const IDLE_FALLBACK_MS = 30_000

export type AgentActivityState = "working" | "waiting" | "exited"

export type WaitingReason = "initial-prompt" | "permission" | "question" | "turn-complete" | "idle"

export type WorkflowRunActivityState = "pending" | "running" | "completed" | "failed"

/**
 * Durable identity plus app-lifetime lifecycle state for one interactive agent
 * PTY. `workflowRunId` is null for an ordinary agent tab.
 */
export interface AgentActivityRecord {
  sessionId: string
  projectId: string
  workspaceId: string | null
  agentId: string
  workflowRunId: string | null
  state: AgentActivityState
  waitingReason: WaitingReason | null
  waitingSince: number | null
  waitingEpisode: number
  waitingNotifiedEpisode: number | null
  turnArmed: boolean
  workflowState: WorkflowRunActivityState | null
  workflowCompletedAt: number | null
  workflowFailureReason: string | null
  createdAt: number
  updatedAt: number
  lastQualifyingOutputAt: number | null
  exitedAt: number | null
}

export interface RegisterAgentActivity {
  sessionId: string
  projectId: string
  workspaceId: string | null
  agentId: string
  workflowRunId: string | null
  turnArmed: boolean
}

export type ScreenClassification =
  | { kind: "normal-prompt"; fingerprint: string }
  | { kind: "permission"; fingerprint: string }
  | { kind: "question"; fingerprint: string }
  | { kind: "fatal"; fingerprint: string; message: string }
  | { kind: "agent-output"; fingerprint: string }
  | { kind: "unknown"; fingerprint: string }

export type ActivityPhase = "acquire" | "working" | "release" | "idle"

export interface ActivityEvent {
  phase: ActivityPhase
  sessionId: string | null
  at: number
}

export interface ActivityRegistrySnapshot {
  sessions: readonly AgentActivityRecord[]
  workingSessionIds: readonly string[]
  hasWorkingActivity: boolean
}

export interface ActivityRegistryChange {
  snapshot: ActivityRegistrySnapshot
  activityEvents: readonly ActivityEvent[]
}

export type ActivityRegistryListener = (change: ActivityRegistryChange) => void

export interface ActivityClock {
  now(): number
}

export interface ActivityTimer {
  cancel(): void
}

export interface ActivityScheduler {
  schedule(delayMs: number, callback: () => void): ActivityTimer
}

export const systemActivityClock: ActivityClock = {
  now: () => Date.now(),
}

export const systemActivityScheduler: ActivityScheduler = {
  schedule: (delayMs, callback) => {
    const handle = setTimeout(callback, delayMs)
    return {
      cancel: () => clearTimeout(handle),
    }
  },
}
