import { createFileRoute } from "@tanstack/react-router"
import { lazy, Suspense } from "react"
import { HealthBanner } from "./components/HealthBanner"
import { Dashboard } from "./index/components/Dashboard"
import { readTerminalSpawnOverride } from "./utils/terminalSpawnOverride"

/**
 * Shell home (md/engineering/architecture.md (renderer); git history (build phases), P7). Behind the boot/health gate (`HealthBanner`,
 * which mounts the `app-ready` marker once the renderer→main→SQLite path is
 * proven) it renders the project-cards **Dashboard** — the default surface.
 *
 * The terminal test seam is preserved: when the E2E loads with `?termcmd=…` it
 * spawns that deterministic program in a live terminal pane instead of the
 * dashboard, so `e2e/terminal.spec.ts` keeps asserting `app-ready` + `terminal`
 * without a standalone route. In normal use no params are present and the home is
 * always the dashboard.
 */
const TerminalSeam = lazy(() =>
  import("./index/components/TerminalSeam").then((module) => ({ default: module.TerminalSeam })),
)

export const Route = createFileRoute("/_shell/")({
  component: IndexView,
})

function IndexView() {
  // Read once per render; the terminal E2E passes a deterministic program via the
  // URL. Present ⇒ render the terminal seam; absent ⇒ render the dashboard.
  const termSpawn = readTerminalSpawnOverride()

  return (
    <HealthBanner>
      {termSpawn ? (
        <Suspense fallback={<div role="status">Loading terminal…</div>}>
          <TerminalSeam termSpawn={termSpawn} />
        </Suspense>
      ) : (
        <Dashboard />
      )}
    </HealthBanner>
  )
}
