import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { LiveAgentStatus } from "../../../shared/agentStatus"
import { useTranslate } from "../../i18n/language"
import { navigateToAgent } from "../../notifications/agentNavigation"
import { overlayIsOpen } from "../../shortcuts/keyGuards"
import { eventMatchesShortcut } from "../../shortcuts/shortcuts"
import { useTRPC } from "../../trpc/react"
import { useAgentStatus } from "./-ProjectActivity"

/** How long the "nothing to go to" notice stays on screen (ms). */
const NOTICE_MS = 2_500

/**
 * The agents waiting for input that a view can open, ordered by the sidebar's
 * project order, then by the agents' start order (the order of `statuses`).
 * With `scopeProjectId`, only that project's agents. A project-view agent with
 * no workspace is left out: the project view cannot attach it.
 */
export function orderWaitingAgents(
  statuses: readonly LiveAgentStatus[],
  projectIds: readonly string[],
  scopeProjectId: string | null,
): LiveAgentStatus[] {
  const rank = (projectId: string): number => {
    const index = projectIds.indexOf(projectId)
    return index === -1 ? projectIds.length : index
  }
  return statuses
    .filter(
      (status) =>
        status.state === "waiting" &&
        (status.origin === "latex" || status.workspaceId !== null) &&
        (scopeProjectId === null || status.projectId === scopeProjectId),
    )
    .map((status, index) => ({ status, index }))
    .sort(
      (left, right) =>
        rank(left.status.projectId) - rank(right.status.projectId) || left.index - right.index,
    )
    .map(({ status }) => status)
}

/**
 * The agent after `lastSessionId` in `ordered`, wrapping to the first. When the
 * last agent is no longer in the list (or there was none), the first agent.
 */
export function nextAgent(
  ordered: readonly LiveAgentStatus[],
  lastSessionId: string | null,
): LiveAgentStatus | null {
  if (ordered.length === 0) return null
  const index = ordered.findIndex((status) => status.sessionId === lastSessionId)
  return ordered[(index + 1) % ordered.length] ?? null
}

/**
 * The project of the current view: the project view's id, or the project the
 * LaTeX Editor was opened on (its `projectId` search value). Null elsewhere,
 * including a LaTeX Editor opened without a project in its address.
 */
export function currentProjectId(pathname: string, search: unknown): string | null {
  const project = /^\/projects\/([^/]+)/.exec(pathname)
  if (project?.[1]) return decodeURIComponent(project[1])
  if (pathname.startsWith("/science/latex") && typeof search === "object" && search !== null) {
    const projectId = (search as Record<string, unknown>).projectId
    if (typeof projectId === "string" && projectId) return projectId
  }
  return null
}

/**
 * App-global "next waiting agent" shortcuts. ⌥Tab (rebindable) opens the next
 * agent waiting for input across all projects; ⌥⇧Tab (rebindable) does the same
 * within the current project. Repeated presses cycle through the list. Each
 * agent opens in the view it was started from (see {@link navigateToAgent}).
 * When there is nothing to open, a short notice says why.
 *
 * The listener runs in the window capture phase and stops the event when it
 * acts, so a focused terminal or editor never receives the key. It leaves the
 * key alone while a dialog, menu or popover is open, or while Settings records
 * a new shortcut.
 */
export function AgentShortcuts({ pathname, search }: { pathname: string; search: unknown }) {
  const t = useTranslate()
  const navigate = useNavigate()
  const trpc = useTRPC()
  const projects = useQuery(trpc.projects.list.queryOptions()).data ?? []
  const { data: statuses } = useAgentStatus()
  const [notice, setNotice] = useState<string | null>(null)

  // The saved project order, as in the sidebar and on the Dashboard.
  const projectIds = projects.map((project) => project.id)
  const stateRef = useRef({ projectIds, statuses: statuses ?? [], pathname, search })
  stateRef.current = { projectIds, statuses: statuses ?? [], pathname, search }
  const lastSessionId = useRef<string | null>(null)
  const requests = useRef(0)

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const all = eventMatchesShortcut(event, "next-waiting-agent")
      const inProject = !all && eventMatchesShortcut(event, "next-waiting-agent-in-project")
      if (!all && !inProject) return
      if (document.querySelector('[data-shortcut-recording="true"]') || overlayIsOpen()) return
      event.preventDefault()
      event.stopPropagation()
      const state = stateRef.current
      const scope = inProject ? currentProjectId(state.pathname, state.search) : null
      if (inProject && scope === null) {
        setNotice("Open a project first")
        return
      }
      const target = nextAgent(
        orderWaitingAgents(state.statuses, state.projectIds, scope),
        lastSessionId.current,
      )
      if (!target) {
        setNotice("No agent is waiting for input")
        return
      }
      lastSessionId.current = target.sessionId
      requests.current += 1
      setNotice(null)
      navigateToAgent(
        navigate,
        {
          projectId: target.projectId,
          workspaceId: target.workspaceId,
          sessionId: target.sessionId,
          agentId: target.agentId,
          origin: target.origin,
        },
        `agent-shortcut-${requests.current}`,
      )
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [navigate])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  if (!notice) return null
  return (
    <div
      role="status"
      data-testid="agent-shortcut-notice"
      className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-border bg-background px-3 py-2 text-foreground text-sm shadow-lg"
    >
      {t(notice)}
    </div>
  )
}
