import { randomUUID } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { app, type BrowserWindow, dialog, ipcMain } from "electron"
import {
  BACKGROUND_TRAY_OPEN_APP_CHANNEL,
  BACKGROUND_TRAY_OPEN_FILE_CHANNEL,
  BACKGROUND_TRAY_OPEN_PROJECT_CHANNEL,
  BACKGROUND_TRAY_QUIT_CHANNEL,
  BACKGROUND_TRAY_SNAPSHOT_CHANNEL,
} from "../shared/backgroundTray"
import {
  QUICK_EDIT_CLOSE_CHANNEL,
  QUICK_EDIT_CURRENT_CHANNEL,
  QUICK_EDIT_OPEN_CHANNEL,
  QUICK_EDIT_READ_CHANNEL,
  QUICK_EDIT_READY_CHANNEL,
  QUICK_EDIT_RESOLVE_ROUTE_CHANNEL,
  QUICK_EDIT_ROUTE_CHANNEL,
  QUICK_EDIT_ROUTES_READY_CHANNEL,
  QUICK_EDIT_SAVE_CHANNEL,
  QUICK_EDIT_SHOW_FULL_CHANNEL,
  QUICK_EDIT_STAT_CHANNEL,
} from "../shared/quickEdit"
import type { BackgroundTray } from "./background/tray"
import type { FullRuntime } from "./fullRuntime"
import { loadNativeLanguage } from "./i18n/nativeLanguage"
import { applyMacDockIcon, resolveAppIconPath } from "./identity/appIcon"
import { FullBootScheduler } from "./quickEdit/fullBootScheduler"
import { firstFileArgument } from "./quickEdit/launchArgs"
import { QuickEditFiles } from "./quickEdit/service"
import { dataDirOverride, isTestMode } from "./runtime/env"
import { registerAnalysisReportScheme } from "./trpc/science/analysis/reportScheme"
import { installAppMenu } from "./window/appMenu"
import { createMainWindow, loadWindowPage } from "./window/mainWindow"
import { installShutdownGuard } from "./window/shutdownGuard"

export type { AppRouter } from "./trpc/appRouter"

/**
 * The small entry starts a file in quick edit before importing fullRuntime.
 * Full services start after the caret is ready or immediately for a full-app
 * request. See md/engineering/architecture.md for the complete boot sequence.
 */

// The product name — also the basename of Electron's default userData dir
// (→ ~/Library/Application Support/PI Lab). Without this, Electron derives the
// name from package.json `name` (`@pi-lab/desktop`) and scatters Chromium state
// under an `@pi-lab/` folder. Must precede any getPath("userData") access.
app.setName("PI Lab")
registerAnalysisReportScheme()

// Step 1 — redirect on-disk state before Electron (or the DB) touches the
// default userData path. Honors PI_LAB_DATA_DIR (md/engineering/testing-and-build.md).
if (dataDirOverride) {
  app.setPath("userData", dataDirOverride)
}

const resolvedAppIconPath = resolveAppIconPath(
  {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  },
  { exists: existsSync },
)
const devIconPath = resolve(__dirname, "../../../..", "icons", "icon.png")
const appIconPath =
  resolvedAppIconPath ?? (!app.isPackaged && existsSync(devIconPath) ? devIconPath : null)

// Step 2 — one instance per data dir in normal use; the smoke harness launches
// many parallel instances against throwaway data dirs, so test mode opts out.
const ownsInstance = isTestMode || app.requestSingleInstanceLock()
if (!ownsInstance) {
  app.quit()
}

const quickFiles = new QuickEditFiles()
let pendingFilePath: string | null = null
let appReady = false
let quickWindow = false
let fullBootComplete = false
let userWindow: BrowserWindow | null = null
let fullRendererReady = false
let pendingFullRoute: string | null = null
let tray: BackgroundTray | null = null
let unsubscribeTray: (() => void) | null = null
let quitting = false
let hiddenStartup = false

/** Close the background surface before a user window appears. */
function closeTray(): void {
  unsubscribeTray?.()
  unsubscribeTray = null
  tray?.dispose()
  tray = null
}

/** Register a user window separately from the tray popover. */
function attachUserWindow(window: BrowserWindow): BrowserWindow {
  userWindow = window
  fullRendererReady = false
  pendingFullRoute = null
  window.webContents.on("did-start-loading", () => {
    fullRendererReady = false
  })
  closeTray()
  shutdownGuard.attachWindow(window)
  window.on("closed", () => {
    if (userWindow !== window) return
    userWindow = null
    if (!quitting)
      void enterBackground().catch((error: unknown) => {
        console.error("[pi-lab] could not enter background:", error)
        app.quit()
      })
  })
  if (fullBootComplete) fullRuntime?.boot(window)
  return window
}

/** Stay resident only when the persisted setting permits it. */
async function enterBackground(): Promise<void> {
  if (!fullBootComplete) await fullBootScheduler.startNow()
  if (userWindow || quitting) return
  const runtime = fullRuntime
  if (!runtime) throw new Error("Full app did not start")
  if (!hiddenStartup && !runtime.keepRunningAfterClose()) {
    app.quit()
    return
  }
  if (tray) return
  if (!appIconPath) throw new Error("PI Lab tray icon is missing")
  const { BackgroundTray } = await import("./background/tray")
  if (userWindow || quitting) return
  const created = new BackgroundTray(appIconPath)
  tray = created
  hiddenStartup = false
  unsubscribeTray = runtime.subscribeTray((snapshot) => created.publish(snapshot))
  if (isTestMode && process.env.PI_LAB_TEST_SHOW_TRAY === "1") created.showForTest()
}

function acceptFile(path: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) return
  const target = quickFiles.register(path)
  if (!appReady) {
    pendingFilePath = target.path
    return
  }
  const window = userWindow
  if (!window) {
    quickWindow = true
    createQuickWindow(target.id)
    return
  }
  const route = !quickWindow && fullRuntime ? fullRuntime.routeForFile(target) : null
  if (route?.startsWith("/projects/")) {
    if (fullRendererReady) window.webContents.send(QUICK_EDIT_ROUTE_CHANNEL, route)
    else pendingFullRoute = route
    window.show()
    window.focus()
    return
  }
  if (window.webContents.isLoadingMainFrame()) {
    window.webContents.once("did-finish-load", () => {
      if (!window.isDestroyed()) window.webContents.send(QUICK_EDIT_OPEN_CHANNEL, target)
    })
  } else {
    window.webContents.send(QUICK_EDIT_OPEN_CHANNEL, target)
  }
  window.show()
  window.focus()
}

if (ownsInstance) {
  app.on("open-file", (event, path) => {
    event.preventDefault()
    acceptFile(path)
  })
  app.on("second-instance", (_event, argv, cwd) => {
    const path = firstFileArgument(argv, cwd, __filename)
    if (path) acceptFile(path)
    else if (userWindow) {
      userWindow.show()
      userWindow.focus()
    } else {
      void app
        .whenReady()
        .then(() => openFull(null))
        .catch((error: unknown) => {
          console.error("[pi-lab] could not open full app:", error)
        })
    }
  })
}

// In test mode there is no auto-update or telemetry to disable yet; the seam is
// reserved here so future wiring stays gated behind one flag (md/engineering/testing-and-build.md).

const shutdownGuard = installShutdownGuard({ app, ipcMain, createRequestId: randomUUID })
let fullRuntime: FullRuntime | null = null

function ensureMainWindow(): BrowserWindow {
  const existing = userWindow
  if (existing) return existing
  return attachUserWindow(createMainWindow(appIconPath, "full", undefined))
}

function createQuickWindow(id: string): BrowserWindow {
  const window = createMainWindow(
    appIconPath,
    "quick",
    `/quick-edit?target=${encodeURIComponent(id)}`,
  )
  return attachUserWindow(window)
}

/** Import full-app code only after the quick editor reports a focused caret. */
function startFullBoot(): Promise<void> {
  return import("./fullRuntime")
    .then(async ({ FullRuntime, reportFullBootFailure }) => {
      const runtime = new FullRuntime({
        appIconPath,
        ensureMainWindow,
        initialWindow: () => {
          const existing = userWindow
          if (existing) return existing
          return quickWindow || hiddenStartup ? null : ensureMainWindow()
        },
      })
      fullRuntime = runtime
      await runtime.start().catch((error: unknown) => {
        reportFullBootFailure(error)
        throw error
      })
      fullBootComplete = true
      if (!userWindow) await enterBackground()
    })
    .catch((error: unknown) => {
      console.error("[pi-lab] fatal during boot:", error)
      throw error
    })
}

const fullBootScheduler = new FullBootScheduler(startFullBoot, 200)

/** Open the full app in the existing user window or a new one. */
async function openFull(route: string | null): Promise<void> {
  await fullBootScheduler.startNow()
  if (!fullRuntime) throw new Error("Full app did not start")
  const current = quickFiles.current()
  const destination = route ?? (quickWindow && current ? fullRuntime.routeForFile(current) : null)
  const window = ensureMainWindow()
  if (quickWindow || destination) await loadWindowPage(window, "full", destination ?? undefined)
  quickWindow = false
  window.show()
  window.focus()
}

ipcMain.handle(
  BACKGROUND_TRAY_SNAPSHOT_CHANNEL,
  () => fullRuntime?.traySnapshot() ?? { projects: [] },
)
ipcMain.handle(BACKGROUND_TRAY_OPEN_APP_CHANNEL, async () => openFull(null))
ipcMain.handle(BACKGROUND_TRAY_OPEN_PROJECT_CHANNEL, async (_event, id: unknown) => {
  if (typeof id !== "string" || !fullRuntime?.hasProject(id)) throw new Error("Unknown project")
  await openFull(`/projects/${encodeURIComponent(id)}`)
})
ipcMain.handle(BACKGROUND_TRAY_OPEN_FILE_CHANNEL, async () => {
  const testFile = isTestMode ? process.env.PI_LAB_TEST_PICK_FILE : undefined
  if (testFile) {
    acceptFile(testFile)
    return
  }
  const result = await dialog.showOpenDialog({ properties: ["openFile"] })
  if (!result.canceled && result.filePaths[0]) acceptFile(result.filePaths[0])
})
ipcMain.on(BACKGROUND_TRAY_QUIT_CHANNEL, () => app.quit())

ipcMain.handle(QUICK_EDIT_CURRENT_CHANNEL, () => quickFiles.current())
ipcMain.handle(QUICK_EDIT_CLOSE_CHANNEL, (_event, id: unknown) => {
  if (typeof id !== "string") throw new Error("Invalid quick-edit file ID")
  quickFiles.close(id)
})
ipcMain.handle(QUICK_EDIT_ROUTES_READY_CHANNEL, () => {
  fullRendererReady = true
  const route = pendingFullRoute
  pendingFullRoute = null
  return route
})
ipcMain.handle(QUICK_EDIT_RESOLVE_ROUTE_CHANNEL, (_event, id: unknown) => {
  if (typeof id !== "string") throw new Error("Invalid quick-edit file ID")
  if (!fullRuntime) throw new Error("Full app has not started")
  return fullRuntime.routeForFile(quickFiles.require(id))
})
ipcMain.handle(QUICK_EDIT_READ_CHANNEL, (_event, id: unknown) => {
  if (typeof id !== "string") throw new Error("Invalid quick-edit file ID")
  return quickFiles.read(id)
})
ipcMain.handle(QUICK_EDIT_STAT_CHANNEL, (_event, id: unknown) => {
  if (typeof id !== "string") throw new Error("Invalid quick-edit file ID")
  return quickFiles.stat(id)
})
ipcMain.handle(
  QUICK_EDIT_SAVE_CHANNEL,
  (_event, id: unknown, content: unknown, baseline: unknown, overwrite: unknown) => {
    if (typeof id !== "string" || typeof content !== "string" || typeof overwrite !== "boolean") {
      throw new Error("Invalid quick-edit save request")
    }
    if (
      !baseline ||
      typeof baseline !== "object" ||
      !("exists" in baseline) ||
      typeof baseline.exists !== "boolean" ||
      !("mtimeMs" in baseline) ||
      typeof baseline.mtimeMs !== "number" ||
      !("size" in baseline) ||
      typeof baseline.size !== "number"
    ) {
      throw new Error("Invalid quick-edit baseline")
    }
    return quickFiles.save(
      id,
      content,
      baseline as { exists: boolean; mtimeMs: number; size: number },
      overwrite,
    )
  },
)
ipcMain.on(QUICK_EDIT_READY_CHANNEL, () => {
  if (quickWindow) fullBootScheduler.schedule()
})
ipcMain.handle(QUICK_EDIT_SHOW_FULL_CHANNEL, async (_event, id: unknown) => {
  if (typeof id !== "string") throw new Error("Invalid quick-edit file ID")
  const target = quickFiles.require(id)
  await fullBootScheduler.startNow()
  const window = ensureMainWindow()
  if (!fullRuntime) throw new Error("Full app did not start")
  await loadWindowPage(window, "full", fullRuntime.routeForFile(target))
  quickWindow = false
})

app
  .whenReady()
  .then(async () => {
    if (!ownsInstance) return
    appReady = true
    if (isTestMode && process.platform === "darwin") app.setActivationPolicy("accessory")
    const dock = app.dock
    applyMacDockIcon(
      appIconPath,
      process.platform,
      dock ? { setIcon: (path) => dock.setIcon(path) } : null,
      { warn: (message) => console.warn(message) },
    )
    loadNativeLanguage(app.getPath("userData"))
    installAppMenu()
    hiddenStartup =
      process.argv.includes("--pi-lab-background") ||
      (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin)
    app.on("activate", () => {
      if (userWindow) return
      void openFull(null).catch((error: unknown) =>
        console.error("[pi-lab] activate failed:", error),
      )
    })

    if (!pendingFilePath) {
      const arg = firstFileArgument(process.argv, process.cwd(), __filename)
      if (arg) quickFiles.register(arg)
    }
    const current = quickFiles.current()
    if (current) {
      hiddenStartup = false
      quickWindow = true
      createQuickWindow(current.id)
      return
    }
    await fullBootScheduler.startNow()
  })
  .catch((error) => {
    console.error("[pi-lab] fatal during startup:", error)
    app.quit()
  })

app.on("window-all-closed", () => {
  // The approved user-window close starts background mode in its `closed` event.
})

app.on("before-quit", (event) => {
  if (!event.defaultPrevented) quitting = true
})

app.on("will-quit", () => {
  quitting = true
  closeTray()
  fullBootScheduler.cancel()
  shutdownGuard.dispose()
  fullRuntime?.dispose()
})
