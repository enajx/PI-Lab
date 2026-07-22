import { createFileRoute, redirect } from "@tanstack/react-router"
import { readShowClusterSection } from "../../../preferences/preferences"
import { ScienceCluster } from "./components/ScienceCluster"

/**
 * Cluster science tab route (AGENTS.md "Scope" / md/engineering/architecture.md (renderer)) — the first wired science tab.
 * Sibling routes (analysis / skills / library) land here as they are built; the
 * nav registry (`scienceNavItems`) already lists them as "coming soon".
 *
 * Guarded by the "Cluster" section preference (Settings → Sections): when the
 * section is hidden, both the sidebar row and this route disappear, so a direct
 * navigation redirects home rather than reaching a hidden surface.
 */
export const Route = createFileRoute("/_shell/science/cluster")({
  beforeLoad: () => {
    if (!readShowClusterSection()) throw redirect({ to: "/" })
  },
  component: ScienceCluster,
})
