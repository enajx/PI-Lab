import { createFileRoute } from "@tanstack/react-router"
import { ScienceLatex } from "./components/ScienceLatex"

/** LaTeX Editor science tab; `projectId` comes from a dashboard project card. */
export const Route = createFileRoute("/_shell/science/latex")({
  validateSearch: (search: Record<string, unknown>): { projectId?: string } => ({
    projectId:
      typeof search.projectId === "string" && search.projectId ? search.projectId : undefined,
  }),
  component: LatexRoute,
})

function LatexRoute() {
  const { projectId } = Route.useSearch()
  return <ScienceLatex key={projectId ?? "default"} initialProjectId={projectId} />
}
