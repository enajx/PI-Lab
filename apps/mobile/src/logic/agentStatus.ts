// The status label of one live agent, from `sessions.onStatus`. The labels
// follow the desktop's notification event names ("Agent needs input", "Agent
// finished its turn") and the title bar's "Working", "Waiting" and "Idle".

/** Why a waiting agent waits (`WaitingReason` in the desktop's activity/types.ts). */
export type WaitingReason = "initial-prompt" | "permission" | "question" | "turn-complete" | "idle"

/** Which dot colour a status uses. */
export type AgentTone = "working" | "needs-input" | "finished" | "idle"

/**
 * The label and dot colour for an agent. A waiting agent with no reason (from
 * a server that does not send one) reads "Waiting", coloured as needing input.
 */
export function agentStatus(agent: {
  state: "working" | "waiting"
  waitingReason?: WaitingReason
}): { label: string; tone: AgentTone } {
  if (agent.state === "working") return { label: "Working", tone: "working" }
  if (agent.waitingReason === "turn-complete") return { label: "Finished", tone: "finished" }
  if (agent.waitingReason === "idle") return { label: "Idle", tone: "idle" }
  if (agent.waitingReason === undefined) return { label: "Waiting", tone: "needs-input" }
  return { label: "Needs input", tone: "needs-input" }
}
