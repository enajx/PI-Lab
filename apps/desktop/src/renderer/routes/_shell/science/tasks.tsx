import { createFileRoute } from "@tanstack/react-router"
import {
  focusSessionFromSearch,
  validateSessionViewSearch,
} from "./components/ScienceSessionPanel/sessionViewSearch"
import { ScienceTasks } from "./components/ScienceTasks"

/**
 * Tasks science tab; `?projectId=<id>` opens it on one project (e.g. from a Tasks
 * button), and `sessionId`, `agentId` and `agentLabel` also focus that agent's tab
 * in its session panel (Project Agents box, ⌥Tab).
 */
export const Route = createFileRoute("/_shell/science/tasks")({
  validateSearch: validateSessionViewSearch,
  component: TasksRoute,
})

function TasksRoute() {
  const search = Route.useSearch()
  return (
    <ScienceTasks
      initialProjectId={search.projectId}
      focusSession={focusSessionFromSearch(search)}
    />
  )
}
