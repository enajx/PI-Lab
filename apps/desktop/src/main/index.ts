import { app, BrowserWindow } from "electron"
import { createIPCHandler } from "trpc-electron/main"
import { dispatchAutomation } from "./automations/dispatch"
import { AutomationScheduler } from "./automations/scheduler"
import { getDb, initDatabase } from "./db/db"
import { dataDirOverride, isTestMode } from "./runtime/env"
import { LiveAgentRegistry } from "./sessions/liveAgentRegistry"
import { TerminalSupervisor } from "./terminal/supervisor"
import { appRouter } from "./trpc/appRouter"
import {
  type AppContext,
  buildAgentCatalog,
  DEFAULT_HTTP_FETCH,
  DEFAULT_PY_TOOLS_EXEC,
  DEFAULT_SSH_EXEC,
} from "./trpc/context"
import { createMainWindow } from "./window/mainWindow"

export type { AppRouter } from "./trpc/appRouter"

/**
 * Main-process boot (a foundation slice of the sequence in AGENTS.md §6):
 *
 *   1. point `userData` at the resolved data dir   (must precede any disk/DB IO)
 *   2. acquire the single-instance lock            (skipped in test mode)
 *   3. open + migrate the local SQLite DB
 *   4. serve the tRPC appRouter (with the PTY-daemon-backed context) over
 *      `trpc-electron`
 *   5. create the window
 *
 * The PTY daemon itself is started lazily on first terminal use (adopt-or-spawn,
 * AGENTS.md §6) so an app that never opens a terminal pays nothing. Later phases
 * insert science-state, eager pty-daemon session reconciliation, the automations
 * scheduler, and tray/menu between steps 3 and 5.
 */

// Step 1 — redirect on-disk state before Electron (or the DB) touches the
// default userData path. Honors SKIPPER_DATA_DIR (AGENTS.md §14).
if (dataDirOverride) {
  app.setPath("userData", dataDirOverride)
}

// Step 2 — one instance per data dir in normal use; the smoke harness launches
// many parallel instances against throwaway data dirs, so test mode opts out.
if (!isTestMode && !app.requestSingleInstanceLock()) {
  app.quit()
}

// In test mode there is no auto-update or telemetry to disable yet; the seam is
// reserved here so future wiring stays gated behind one flag (AGENTS.md §14).

let ipcHandler: ReturnType<typeof createIPCHandler> | null = null

// The PTY daemon supervisor is created once and shared across the app's life.
// It adopts a daemon a prior run left detached, or spawns one (AGENTS.md §6); it
// is NOT torn down with windows so terminals survive a reload.
const terminalSupervisor = new TerminalSupervisor()

// Per-project tally of live agent sessions, shared across requests for the app's
// lifetime so the start-agent-session policy (AGENTS.md §8) sees a stable count.
// It drains itself via the daemon's `exit` stream.
const liveAgents = new LiveAgentRegistry()

// The launchable agent catalog. In test mode it includes the deterministic
// test-echo agent so the E2E can launch an assertable agent (AGENTS.md §14).
const agentCatalog = buildAgentCatalog(isTestMode)

// Context built per request (after boot has migrated the DB). The terminal +
// agent-launch paths resolve their daemon client lazily through the supervisor
// (adopt-or-spawn + reconnect); the DB handle, agent catalog, and live-session
// registry are app-lifetime singletons.
function createAppContext(): AppContext {
  return {
    db: getDb(),
    getDaemonClient: () => terminalSupervisor.ensureClient(),
    agentCatalog,
    liveAgents,
    sshExec: DEFAULT_SSH_EXEC,
    httpFetch: DEFAULT_HTTP_FETCH,
    pyToolsExec: DEFAULT_PY_TOOLS_EXEC,
  }
}

// The automations scheduler (AGENTS.md §1 / §6). Its "fire" builds the same
// AppContext the routers use and dispatches the due automation through the
// shared session-start flow, so a scheduled run is identical to a manual one.
// Created on first boot (after the DB is migrated) and stopped on quit.
let automationScheduler: AutomationScheduler | null = null

function startAutomationScheduler(): void {
  if (automationScheduler) return
  automationScheduler = new AutomationScheduler({
    db: getDb(),
    fire: (args) => dispatchAutomation(createAppContext(), args),
  })
  automationScheduler.start()
}

function boot(window: BrowserWindow): void {
  // One IPC handler for the app's lifetime; re-attach windows rather than
  // re-create it (avoids duplicate handlers when a window is reopened).
  if (ipcHandler) {
    ipcHandler.attachWindow(window)
    return
  }
  ipcHandler = createIPCHandler({
    router: appRouter,
    windows: [window],
    createContext: async () => createAppContext(),
  })
}

app
  .whenReady()
  .then(() => {
    // Step 3 — migrate the DB; the renderer's `app-ready` marker proves this ran.
    const dbStatus = initDatabase()
    console.log(
      `[skipper] db migrated: applied=${dbStatus.appliedCount} latest=${dbStatus.latestTag ?? "none"} recovered=${dbStatus.recovered}`,
    )

    // Start the automations scheduler timer (reconciles schedules on boot, then
    // ticks). Done before the window so a due automation fires even if the
    // renderer is slow to mount (AGENTS.md §6).
    startAutomationScheduler()

    // Steps 4 + 5 — wire tRPC, then open the window.
    const window = createMainWindow()
    boot(window)

    // macOS: recreate the window when the dock icon is clicked with none open.
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        boot(createMainWindow())
      }
    })
  })
  .catch((error) => {
    console.error("[skipper] fatal during boot:", error)
    app.quit()
  })

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

// Close our client to the daemon on quit, but deliberately leave the *detached*
// daemon process running so live terminals/agents survive the app restarting —
// the whole reason it is a separate process (AGENTS.md §6).
app.on("before-quit", () => {
  automationScheduler?.stop()
  terminalSupervisor.dispose()
})
