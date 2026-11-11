import type { AgentSessionOrigin } from "@pi-lab/local-db"
import type { useNavigate } from "@tanstack/react-router"

/** The router's navigate function, as returned by `useNavigate()`. */
export type Navigate = ReturnType<typeof useNavigate>

/** A live agent to open with its tab focused. */
export interface AgentTarget {
  projectId: string
  /** Required for an agent that opens in the project view (origin "project" or "routine"). */
  workspaceId: string | null
  sessionId: string
  agentId: string
  /** The view the agent was started from. */
  origin: AgentSessionOrigin
  /** The tab label; the agent id is used when there is none. */
  label?: string
}

/** The views with their own agent tabs, by the origin of the agents they show. */
const VIEW_FOR_ORIGIN = {
  latex: "/science/latex",
  analysis: "/science/analysis",
  tasks: "/science/tasks",
} as const

/**
 * Open the view an agent was started from with that agent's tab focused. A LaTeX
 * Editor, Analysis or Tasks agent opens that view on the agent's project, with the
 * tab in its session panel. A Project view agent, and a routine's agent (the
 * Routines page has no agent tabs), open the project view, which attaches the
 * session once per `requestId` (a new id per request, so a repeated request for
 * the same agent focuses it again). Throws for a project view agent without a
 * workspace, which the project view cannot attach.
 */
export function navigateToAgent(navigate: Navigate, target: AgentTarget, requestId: string): void {
  if (target.origin === "latex" || target.origin === "analysis" || target.origin === "tasks") {
    void navigate({
      to: VIEW_FOR_ORIGIN[target.origin],
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

/** Whether the view an agent opens in can show it: only the project view needs a workspace. */
export function agentCanOpen(target: Pick<AgentTarget, "origin" | "workspaceId">): boolean {
  return (target.origin !== "project" && target.origin !== "routine") || target.workspaceId !== null
}
