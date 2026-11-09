import { createFileRoute } from "@tanstack/react-router"
import { ScienceTasks } from "./components/ScienceTasks"

/** Tasks science tab; `?projectId=<id>` opens it on one project (e.g. from a Tasks button). */
export const Route = createFileRoute("/_shell/science/tasks")({
  validateSearch: (search: Record<string, unknown>): { projectId?: string } => ({
    projectId:
      typeof search.projectId === "string" && search.projectId ? search.projectId : undefined,
  }),
  component: TasksRoute,
})

function TasksRoute() {
  const { projectId } = Route.useSearch()
  return <ScienceTasks initialProjectId={projectId} />
}
