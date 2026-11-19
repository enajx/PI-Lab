import { createFileRoute } from "@tanstack/react-router"
import { MachineScope } from "../../../machines/machines"
import {
  focusSessionFromSearch,
  validateSessionViewSearch,
} from "./components/ScienceSessionPanel/sessionViewSearch"
import { ScienceTasks } from "./components/ScienceTasks"

/**
 * Tasks science tab; `?projectId=<id>` opens it on one project (e.g. from a Tasks
 * button), and `sessionId`, `agentId` and `agentLabel` also focus that agent's tab
 * in its session panel (Project Agents box, ⌥Tab). `machineId` shows a project
 * of another machine: every call goes to that machine's server.
 */
export const Route = createFileRoute("/_shell/science/tasks")({
  validateSearch: validateSessionViewSearch,
  component: TasksRoute,
})

function TasksRoute() {
  const search = Route.useSearch()
  return (
    <MachineScope machineId={search.machineId ?? null}>
      <ScienceTasks
        key={search.machineId ?? "local"}
        initialProjectId={search.projectId}
        focusSession={focusSessionFromSearch(search)}
      />
    </MachineScope>
  )
}
