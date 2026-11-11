import type { AgentSessionOrigin, WorkflowTask } from "@pi-lab/local-db"

/** What the Project Agents box shows for one row. */
export type ProjectAgentStatus = "working" | "waiting" | "done" | "failed"

/**
 * One row of a project's "Project Agents" box: a live agent started outside the
 * Project view, or a background workflow run that is running.
 */
export type ProjectAgentRow =
  | {
      kind: "agent"
      sessionId: string
      agentId: string
      /** The workspace the agent runs in, or null; a routine's agent opens in the Project view with it. */
      workspaceId: string | null
      /** Where the agent was started (never "project"). */
      origin: Exclude<AgentSessionOrigin, "project">
      /** The agent's catalog label, e.g. "Claude Code". */
      name: string
      status: ProjectAgentStatus
      /** When the agent was last active (epoch ms); the current time while working. */
      lastActiveAt: number
    }
  | {
      kind: "background"
      task: WorkflowTask
      status: ProjectAgentStatus
      /** The current time while the run is working (epoch ms). */
      lastActiveAt: number
    }
