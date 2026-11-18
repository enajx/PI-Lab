import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { MachineScope } from "../../../../../machines/machines"
import { projectNotificationSearchSchema } from "../../../../../notifications/activation"
import { useTRPC } from "../../../../../trpc/react"
import { useEscapeToDashboard } from "../../../projects/-escapeToDashboard"
import { ProjectWorkspace } from "../../../projects/-ProjectWorkspace"

/**
 * A project on a remote machine: the same workspace as `/projects/$projectId`,
 * with every call (files, terminals, agents) going to that machine's server
 * ({@link MachineScope}). Local projects keep `/projects/$projectId`; a link
 * that names this Mac's own machine id goes there.
 */
export const Route = createFileRoute("/_shell/m/$machineId/projects/$projectId")({
  validateSearch: (search) => projectNotificationSearchSchema.parse(search),
  component: MachineProjectRoute,
})

function MachineProjectRoute() {
  const { machineId, projectId } = Route.useParams()
  const activation = Route.useSearch()
  const trpc = useTRPC()
  const hello = useQuery(trpc.server.hello.queryOptions())
  useEscapeToDashboard()
  if (hello.data?.machineId === machineId) {
    return <Navigate to="/projects/$projectId" params={{ projectId }} search={activation} replace />
  }
  return (
    <MachineScope machineId={machineId}>
      <ProjectWorkspace
        key={`${machineId}/${projectId}`}
        projectId={projectId}
        activation={activation}
      />
    </MachineScope>
  )
}
