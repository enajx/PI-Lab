import type { AgentSessionOrigin } from "@pi-lab/local-db"
import type { useNavigate } from "@tanstack/react-router"

/** The router's navigate function, as returned by `useNavigate()`. */
export type Navigate = ReturnType<typeof useNavigate>

/** A live agent to open with its tab focused. */
export interface AgentTarget {
  projectId: string
  /** Required for an agent that opens in the project view. */
  workspaceId: string | null
  sessionId: string
  agentId: string
  /** The view the agent was started from. */
  origin: AgentSessionOrigin
  /** The tab label; the agent id is used when there is none. */
  label?: string
}

/**
 * Open the view that owns an agent with that agent's tab focused. A LaTeX Editor
 * agent opens the LaTeX Editor; any other agent opens its project view, which
 * attaches the session once per `requestId` (a new id per request, so a repeated
 * request for the same agent focuses it again). Throws for a project-view agent
 * without a workspace, which the project view cannot attach.
 */
export function navigateToAgent(navigate: Navigate, target: AgentTarget, requestId: string): void {
  if (target.origin === "latex") {
    void navigate({
      to: "/science/latex",
      search: {
        projectId: target.projectId,
        sessionId: target.sessionId,
        agentId: target.agentId,
        agentLabel: target.label ?? target.agentId,
      },
    })
    return
  }
  if (target.workspaceId === null) {
    throw new Error(`Agent session ${target.sessionId} has no workspace to open`)
  }
  void navigate({
    to: "/projects/$projectId",
    params: { projectId: target.projectId },
    search: {
      notificationId: requestId,
      notificationKind: "agent",
      notificationSessionId: target.sessionId,
      notificationWorkspaceId: target.workspaceId,
      notificationAgentId: target.agentId,
      notificationLabel: target.label,
    },
  })
}
