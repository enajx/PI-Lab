import { createFileRoute, redirect } from "@tanstack/react-router"
import { MachineScope } from "../../../machines/machines"
import { readShowAnalysisSection } from "../../../preferences/preferences"
import { ScienceAnalysis } from "./components/ScienceAnalysis"
import {
  focusSessionFromSearch,
  validateSessionViewSearch,
} from "./components/ScienceSessionPanel/sessionViewSearch"

/**
 * Analysis science tab route — the read-only data browser.
 * Sibling routes (cluster / skills / library) live alongside; the nav registry
 * (`scienceNavItems`) lists the as-yet-unbuilt ones as "coming soon".
 *
 * `?projectId=` opens it on one project, `file` previews that file; `sessionId`, `agentId` and `agentLabel`
 * also focus that agent's tab in its session panel (Project Agents box, ⌥Tab).
 * `machineId` shows a project of another machine through that machine's server.
 *
 * Guarded by the "Analysis" section preference (Settings → Sections): when the
 * section is hidden, both the sidebar row and this route disappear, so a direct
 * navigation redirects home rather than reaching a hidden surface.
 */
export const Route = createFileRoute("/_shell/science/analysis")({
  validateSearch: validateSessionViewSearch,
  beforeLoad: () => {
    if (!readShowAnalysisSection()) throw redirect({ to: "/" })
  },
  component: AnalysisRoute,
})

function AnalysisRoute() {
  const search = Route.useSearch()
  return (
    <MachineScope machineId={search.machineId ?? null}>
      <ScienceAnalysis
        key={search.machineId ?? "local"}
        initialProjectId={search.projectId}
        initialFile={search.file ?? null}
        focusSession={focusSessionFromSearch(search)}
      />
    </MachineScope>
  )
}
