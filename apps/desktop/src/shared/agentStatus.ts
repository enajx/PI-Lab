/** Live state used by project indicators and the title bar. */
export interface LiveAgentStatus {
  sessionId: string
  projectId: string
  projectName: string
  agentId: string
  state: "working" | "waiting"
}
