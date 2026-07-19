import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { getSettingsOrDefaults } from "@pi-lab/local-db"
import { app, BrowserWindow, safeStorage, shell } from "electron"
import { createIPCHandler } from "trpc-electron/main"
import {
  type ActivityMonitorPort,
  ActivityRegistry,
  createActivityMonitor,
  systemActivityClock,
  systemActivityScheduler,
} from "./activity"
import { dispatchAutomation } from "./automations/dispatch"
import { AutomationScheduler } from "./automations/scheduler"
import { CaffeineController, electronPowerSaveBlockerAdapter } from "./caffeine"
import { getDb, initDatabase } from "./db/db"
import { applyMacDockIcon, resolveAppIconPath } from "./identity/appIcon"
import {
  createElectronAppFocusAdapter,
  createElectronNativeNotificationAdapter,
  createNotificationBrokers,
  NotificationService,
} from "./notifications"
import { dataDirOverride, isTestMode, skillsHomeDirOverride } from "./runtime/env"
import { testSetupProbe } from "./setup/testProbe"
import { TerminalSupervisor } from "./terminal/supervisor"
import { appRouter } from "./trpc/appRouter"
import {
  type AppContext,
  buildAgentCatalog,
  DEFAULT_AGENT_EXECUTABLE_RESOLVER,
  DEFAULT_AGENT_LAUNCH_ENVIRONMENT,
  DEFAULT_HTTP_FETCH,
  DEFAULT_PY_TOOLS_EXEC,
  DEFAULT_PYTHON_ENVIRONMENT_DISCOVERER,
  DEFAULT_PYTHON_RUNTIME_RESOLVER,
  DEFAULT_SETUP_PROBE,
  DEFAULT_SSH_EXEC,
  DEFAULT_WORKFLOW_PROCESS_RUNNER,
} from "./trpc/context"
import { seedWritableTemplate } from "./trpc/template"
import { installAppMenu } from "./window/appMenu"
import { createMainWindow } from "./window/mainWindow"

export type { AppRouter } from "./trpc/appRouter"

/**
 * Main-process boot (a foundation slice of the sequence in md/engineering/architecture.md (process model)):
 *
 *   1. point `userData` at the resolved data dir   (must precede any disk/DB IO)
 *   2. acquire the single-instance lock            (skipped in test mode)
 *   3. open + migrate the local SQLite DB
 *   4. serve the tRPC appRouter (with the PTY-daemon-backed context) over
 *      `trpc-electron`
 *   5. create the window
 *
 * The PTY daemon itself is started lazily on first terminal use (adopt-or-spawn,
 * md/engineering/architecture.md (process model)) so an app that never opens a terminal pays nothing. Later phases
 * insert science-state, eager pty-daemon session reconciliation, the automations
 * scheduler, and tray/menu between steps 3 and 5.
 */

// The product name — also the basename of Electron's default userData dir
// (→ ~/Library/Application Support/PI Lab). Without this, Electron derives the
// name from package.json `name` (`@pi-lab/desktop`) and scatters Chromium state
// under an `@pi-lab/` folder. Must precede any getPath("userData") access.
app.setName("PI Lab")

// Step 1 — redirect on-disk state before Electron (or the DB) touches the
// default userData path. Honors PI_LAB_DATA_DIR (md/engineering/testing-and-build.md).
if (dataDirOverride) {
  app.setPath("userData", dataDirOverride)
}

const appIconPath = resolveAppIconPath(
  {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  },
  { exists: existsSync },
)

// Step 2 — one instance per data dir in normal use; the smoke harness launches
// many parallel instances against throwaway data dirs, so test mode opts out.
if (!isTestMode && !app.requestSingleInstanceLock()) {
  app.quit()
}

// In test mode there is no auto-update or telemetry to disable yet; the seam is
// reserved here so future wiring stays gated behind one flag (md/engineering/testing-and-build.md).

let ipcHandler: ReturnType<typeof createIPCHandler> | null = null

// The PTY daemon supervisor is created once and shared across the app's life.
// It adopts a daemon a prior run left detached, or spawns one (md/engineering/architecture.md (process model)); it
// is NOT torn down with windows so terminals survive a reload.
//
// Test mode is the exception: each E2E run gets a throwaway daemon on a unique
// socket, so we reap it on quit — otherwise the orphaned daemon + its node-pty
// children wedge Playwright's `app.close()` on Linux (it waits on the Electron
// child's stdio-pipe EOF). Production keeps the daemon detached so sessions
// survive a restart.
const terminalSupervisor = new TerminalSupervisor(isTestMode ? { reapDaemonOnDispose: true } : {})

// The launchable agent catalog. In test mode it includes the deterministic
// test-echo agent so the E2E can launch an assertable agent (md/engineering/testing-and-build.md).
const agentCatalog = buildAgentCatalog(isTestMode)
const notificationBrokers = createNotificationBrokers()
const notificationService = new NotificationService({
  native: createElectronNativeNotificationAdapter(appIconPath),
  focus: createElectronAppFocusAdapter(ensureMainWindow),
  getPreferences: () => getSettingsOrDefaults(getDb()).notifications,
  activations: notificationBrokers.activations,
  sounds: notificationBrokers.sounds,
  errors: notificationBrokers.errors,
  logger: { warn: (message) => console.warn(message) },
})
const activityRegistry = new ActivityRegistry({
  clock: systemActivityClock,
  scheduler: systemActivityScheduler,
})
let activityMonitor: ActivityMonitorPort | null = null
let caffeineController: CaffeineController | null = null

// Context built per request (after boot has migrated the DB). The terminal +
// agent-launch paths resolve their daemon client lazily through the supervisor
// (adopt-or-spawn + reconnect); the DB handle, agent catalog, and live-session
// registry are app-lifetime singletons.
function createAppContext(): AppContext {
  if (!activityMonitor) throw new Error("activity monitor is not initialized")
  if (!caffeineController) throw new Error("caffeine controller is not initialized")
  return {
    db: getDb(),
    skillsHomeDir: skillsHomeDirOverride ?? homedir(),
    getDaemonClient: () => terminalSupervisor.ensureClient(),
    agentCatalog,
    resolveAgentExecutable: DEFAULT_AGENT_EXECUTABLE_RESOLVER,
    getAgentLaunchEnvironment: DEFAULT_AGENT_LAUNCH_ENVIRONMENT,
    runNonInteractiveProcess: DEFAULT_WORKFLOW_PROCESS_RUNNER,
    setupProbe: isTestMode ? testSetupProbe : DEFAULT_SETUP_PROBE,
    credentialCipher: {
      encrypt: (value) => {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error("Your operating system keychain is unavailable for API-key storage")
        }
        return safeStorage.encryptString(value).toString("base64")
      },
    },
    sshExec: DEFAULT_SSH_EXEC,
    httpFetch: DEFAULT_HTTP_FETCH,
    // Library folder source opens PDFs with the OS default app (md/engineering/architecture.md).
    openPath: (path) => shell.openPath(path),
    pyToolsExec: DEFAULT_PY_TOOLS_EXEC,
    discoverPythonEnvironments: DEFAULT_PYTHON_ENVIRONMENT_DISCOVERER,
    resolvePythonRuntime: DEFAULT_PYTHON_RUNTIME_RESOLVER,
    notifications: notificationBrokers,
    activityMonitor,
    notificationService,
    caffeine: caffeineController,
  }
}

// The automations scheduler (AGENTS.md "Scope" / md/engineering/architecture.md (process model)). Its "fire" builds the same
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

function ensureMainWindow(): BrowserWindow {
  const existing = BrowserWindow.getAllWindows()[0]
  if (existing) return existing
  const window = createMainWindow(appIconPath)
  boot(window)
  return window
}

app
  .whenReady()
  .then(async () => {
    const dock = app.dock
    applyMacDockIcon(
      appIconPath,
      process.platform,
      dock ? { setIcon: (path) => dock.setIcon(path) } : null,
      { warn: (message) => console.warn(message) },
    )

    // Step 3 — migrate the DB; the renderer's `app-ready` marker proves this ran.
    const dbStatus = initDatabase()
    console.log(
      `[pi-lab] db migrated: applied=${dbStatus.appliedCount} latest=${dbStatus.latestTag ?? "none"} recovered=${dbStatus.recovered}`,
    )
    activityMonitor = createActivityMonitor({
      db: getDb(),
      registry: activityRegistry,
      getMonitorClient: () => terminalSupervisor.ensureMonitorClient(),
      notifications: notificationService,
      scheduler: systemActivityScheduler,
      logger: { warn: (message) => console.warn(message) },
    })
    await activityMonitor.reconcile().catch((error) => {
      console.warn(`[pi-lab] activity reconciliation skipped: ${String(error)}`)
    })
    caffeineController = new CaffeineController({
      power: electronPowerSaveBlockerAdapter,
      clock: systemActivityClock,
      scheduler: systemActivityScheduler,
      activity: activityRegistry,
      initialSettings: getSettingsOrDefaults(getDb()).caffeine,
    })

    // First-run seed of the writable project template (data dir is already set in
    // step 1). Fire-and-forget + graceful: a failure logs but never aborts boot,
    // and the template router re-seeds lazily as a safety net.
    void seedWritableTemplate().catch((error) => {
      console.warn("[pi-lab] template seed skipped:", error)
    })

    // Start the automations scheduler timer (reconciles schedules on boot, then
    // ticks). Done before the window so a due automation fires even if the
    // renderer is slow to mount (md/engineering/architecture.md (process model)).
    startAutomationScheduler()

    // Own the application menu so ⌘W is NOT bound to "Close Window" — the project
    // view handles ⌘W to close the active tab instead (see appMenu.ts / CentralPanel).
    installAppMenu()

    // Steps 4 + 5 — wire tRPC, then open the window.
    const window = createMainWindow(appIconPath)
    boot(window)

    // macOS: recreate the window when the dock icon is clicked with none open.
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        ensureMainWindow()
      }
    })
  })
  .catch((error) => {
    console.error("[pi-lab] fatal during boot:", error)
    app.quit()
  })

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

// Stop the scheduler and dispose the supervisor on quit. In production the
// supervisor closes its client but deliberately leaves the *detached* daemon
// running so live terminals/agents survive the app restarting — the whole reason
// it is a separate process (md/engineering/architecture.md (process model)). In test mode
// dispose also reaps that daemon (see TerminalSupervisor construction above).
app.on("before-quit", () => {
  automationScheduler?.stop()
  caffeineController?.dispose()
  activityMonitor?.dispose()
  activityRegistry.dispose()
  terminalSupervisor.dispose()
})
