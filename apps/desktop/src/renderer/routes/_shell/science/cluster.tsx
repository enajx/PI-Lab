import { createFileRoute } from "@tanstack/react-router"
import { ScienceCluster } from "./components/ScienceCluster"

/**
 * Cluster science tab route (AGENTS.md "Scope" / docs/architecture.md (renderer)) — the first wired science tab.
 * Sibling routes (analysis / skills / library) land here as they are built; the
 * nav registry (`scienceNavItems`) already lists them as "coming soon".
 */
export const Route = createFileRoute("/_shell/science/cluster")({
  component: ScienceCluster,
})
