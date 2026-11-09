import { createFileRoute } from "@tanstack/react-router"
import { ScienceLatex } from "./components/ScienceLatex"

/** Search params of the LaTeX Editor route. */
export interface LatexSearch {
  /** Project to show; set by a dashboard project card or the Project Agents box. */
  projectId?: string
  /** An agent session to focus (from the Project Agents box or a notification). */
  sessionId?: string
  agentId?: string
  agentLabel?: string
}

/** A non-empty string search value, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

/** LaTeX Editor science tab; `projectId` comes from a dashboard project card. */
export const Route = createFileRoute("/_shell/science/latex")({
  validateSearch: (search: Record<string, unknown>): LatexSearch => ({
    projectId: text(search.projectId),
    sessionId: text(search.sessionId),
    agentId: text(search.agentId),
    agentLabel: text(search.agentLabel),
  }),
  component: LatexRoute,
})

function LatexRoute() {
  const { projectId, sessionId, agentId, agentLabel } = Route.useSearch()
  const focusSession =
    sessionId && agentId ? { sessionId, agentId, agentLabel: agentLabel ?? agentId } : null
  return (
    <ScienceLatex
      key={projectId ?? "default"}
      initialProjectId={projectId}
      focusSession={focusSession}
    />
  )
}
