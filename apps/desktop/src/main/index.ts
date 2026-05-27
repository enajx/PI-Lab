import { app, BrowserWindow } from "electron"
import { createIPCHandler } from "trpc-electron/main"
import { initDatabase } from "./db/db"
import { dataDirOverride, isTestMode } from "./runtime/env"
import { appRouter } from "./trpc/appRouter"
import { createMainWindow } from "./window/mainWindow"

export type { AppRouter } from "./trpc/appRouter"

/**
 * Main-process boot (a foundation slice of the sequence in AGENTS.md §6):
 *
 *   1. point `userData` at the resolved data dir   (must precede any disk/DB IO)
 *   2. acquire the single-instance lock            (skipped in test mode)
 *   3. open + migrate the local SQLite DB
 *   4. serve the tRPC appRouter to the renderer over `trpc-electron`
 *   5. create the window
 *
 * Later phases insert science-state, pty-daemon reconciliation, the automations
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

function boot(window: BrowserWindow): void {
  // One IPC handler for the app's lifetime; re-attach windows rather than
  // re-create it (avoids duplicate handlers when a window is reopened).
  if (ipcHandler) {
    ipcHandler.attachWindow(window)
    return
  }
  ipcHandler = createIPCHandler({ router: appRouter, windows: [window] })
}

app
  .whenReady()
  .then(() => {
    // Step 3 — migrate the DB; the renderer's `app-ready` marker proves this ran.
    const dbStatus = initDatabase()
    console.log(
      `[skipper] db migrated: applied=${dbStatus.appliedCount} latest=${dbStatus.latestTag ?? "none"} recovered=${dbStatus.recovered}`,
    )

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
