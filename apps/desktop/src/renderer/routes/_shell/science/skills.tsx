import { createFileRoute } from "@tanstack/react-router"
import { ScienceSkills } from "./components/ScienceSkills"

/**
 * Skills science tab route (AGENTS.md "Scope" / md/engineering/architecture.md (renderer)) — the read-only skills catalog.
 * Sibling routes (analysis / library) land here as they are built; the nav
 * registry (`scienceNavItems`) already lists them as "coming soon".
 */
export const Route = createFileRoute("/_shell/science/skills")({
  component: ScienceSkills,
})
