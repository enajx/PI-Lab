import type { AgentSessionOrigin } from "@pi-lab/local-db"

/** Live state used by project indicators, the title bar and the waiting-agent shortcuts. */
export interface LiveAgentStatus {
  sessionId: string
  projectId: string
  projectName: string
  agentId: string
  /** The workspace the agent runs in; null for a session without one. */
  workspaceId: string | null
  /** The view the agent was started from; it decides which view opens the agent. */
  origin: AgentSessionOrigin
  state: "working" | "waiting"
}
