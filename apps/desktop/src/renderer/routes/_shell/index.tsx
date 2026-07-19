import { createFileRoute } from "@tanstack/react-router"
import { Terminal } from "../../Terminal"
import { useTRPCClient } from "../../trpc/react"
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
export const Route = createFileRoute("/_shell/")({
  component: IndexView,
})

function IndexView() {
  // Read once per render; the terminal E2E passes a deterministic program via the
  // URL. Present ⇒ render the terminal seam; absent ⇒ render the dashboard.
  const termSpawn = readTerminalSpawnOverride()

  return (
    <HealthBanner>
      {termSpawn ? <TerminalSeam termSpawn={termSpawn} /> : <Dashboard />}
    </HealthBanner>
  )
}

/** The standalone-terminal test seam (md/engineering/testing-and-build.md), gated to `?termcmd` runs. */
function TerminalSeam({
  termSpawn,
}: {
  termSpawn: { command?: string; args?: string[]; inputKind: "agent" | "terminal" }
}) {
  // Reuse the ONE app-wide tRPC client (the same instance backing TanStack
  // Query). A second `ipcLink` over the same channel cross-wires responses, so
  // the terminal must share, not create, the client.
  const client = useTRPCClient()
  return (
    <div className="flex h-full flex-col gap-4 p-8">
      <section className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
        <Terminal
          client={client}
          inputKind={termSpawn.inputKind}
          command={termSpawn.command}
          args={termSpawn.args}
        />
      </section>
    </div>
  )
}
