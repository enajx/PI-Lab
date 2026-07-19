import { createFileRoute } from "@tanstack/react-router"
import { workflowNotificationSearchSchema } from "../../notifications/activation"
import { AutomationsView } from "./automations/components/AutomationsView"

/**
 * Workflows route (AGENTS.md "Scope" / md/engineering/architecture.md (renderer)) — scheduled & looping agent runs. A
 * top-level v1 surface reached from the sidebar; the firing happens in the
 * main-process scheduler, this route is the management UI.
 */
export const Route = createFileRoute("/_shell/automations")({
  validateSearch: (search) => workflowNotificationSearchSchema.parse(search),
  component: AutomationsRoute,
})

function AutomationsRoute() {
  const search = Route.useSearch()
  const activation =
    search.notificationWorkflowId && search.notificationRunId
      ? { workflowId: search.notificationWorkflowId, runId: search.notificationRunId }
      : undefined
  return <AutomationsView activation={activation} />
}
