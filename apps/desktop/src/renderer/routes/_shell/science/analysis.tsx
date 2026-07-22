import { createFileRoute, redirect } from "@tanstack/react-router"
import { readShowAnalysisSection } from "../../../preferences/preferences"
import { ScienceAnalysis } from "./components/ScienceAnalysis"

/**
 * Analysis science tab route (AGENTS.md "Scope" / md/engineering/architecture.md (renderer)) — the read-only data browser.
 * Sibling routes (cluster / skills / library) live alongside; the nav registry
 * (`scienceNavItems`) lists the as-yet-unbuilt ones as "coming soon".
 *
 * Guarded by the "Analysis" section preference (Settings → Sections): when the
 * section is hidden, both the sidebar row and this route disappear, so a direct
 * navigation redirects home rather than reaching a hidden surface.
 */
export const Route = createFileRoute("/_shell/science/analysis")({
  beforeLoad: () => {
    if (!readShowAnalysisSection()) throw redirect({ to: "/" })
  },
  component: ScienceAnalysis,
})
