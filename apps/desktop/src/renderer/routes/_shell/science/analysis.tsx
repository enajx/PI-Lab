import { createFileRoute } from "@tanstack/react-router"
import { ScienceAnalysis } from "./components/ScienceAnalysis"

/**
 * Analysis science tab route (AGENTS.md "Scope" / docs/architecture.md (renderer)) — the read-only data browser.
 * Sibling routes (cluster / skills / library) live alongside; the nav registry
 * (`scienceNavItems`) lists the as-yet-unbuilt ones as "coming soon".
 */
export const Route = createFileRoute("/_shell/science/analysis")({
  component: ScienceAnalysis,
})
