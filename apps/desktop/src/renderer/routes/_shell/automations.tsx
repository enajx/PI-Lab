import { createFileRoute } from "@tanstack/react-router"
import { AutomationsView } from "./automations/components/AutomationsView"

/**
 * Workflows route (AGENTS.md §1 / §7) — scheduled & looping agent runs. A
 * top-level v1 surface reached from the sidebar; the firing happens in the
 * main-process scheduler, this route is the management UI.
 */
export const Route = createFileRoute("/_shell/automations")({
  component: AutomationsView,
})
