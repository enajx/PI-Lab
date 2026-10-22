import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { app, type BrowserWindow, dialog, ipcMain, nativeImage } from "electron"
import {
  APP_ICON_GET_CHANNEL,
  APP_ICON_IDENTITY_CHANNEL,
  APP_ICON_PREVIEW_CHANNEL,
  APP_ICON_SET_CHANNEL,
  isAppIconSelection,
} from "../shared/appIcon"
import {
  BACKGROUND_TRAY_OPEN_FILE_CHANNEL,
  BACKGROUND_TRAY_OPEN_PROJECT_CHANNEL,
  BACKGROUND_TRAY_RESTART_TO_UPDATE_CHANNEL,
  BACKGROUND_TRAY_SNAPSHOT_CHANNEL,
  type BackgroundTraySnapshot,
} from "../shared/backgroundTray"
import {
  QUICK_EDIT_CLOSE_CHANNEL,
  QUICK_EDIT_CURRENT_CHANNEL,
  QUICK_EDIT_EDITOR_VIM_CHANNEL,
  QUICK_EDIT_OPEN_CHANNEL,
  QUICK_EDIT_PYTHON_KILL_CHANNEL,
  QUICK_EDIT_PYTHON_OPTIONS_CHANNEL,
  QUICK_EDIT_PYTHON_RUN_CHANNEL,
  QUICK_EDIT_PYTHON_SELECT_CHANNEL,
  QUICK_EDIT_READ_CHANNEL,
  QUICK_EDIT_READY_CHANNEL,
  QUICK_EDIT_RESOLVE_ROUTE_CHANNEL,
  QUICK_EDIT_ROUTE_CHANNEL,
  QUICK_EDIT_ROUTES_READY_CHANNEL,
  QUICK_EDIT_SAVE_CHANNEL,
  QUICK_EDIT_SAVE_UNTITLED_CHANNEL,
  QUICK_EDIT_SHOW_FULL_CHANNEL,
  QUICK_EDIT_SHOW_SETTINGS_CHANNEL,
  QUICK_EDIT_STAT_CHANNEL,
} from "../shared/quickEdit"
import type { BackgroundTray } from "./background/tray"
import { createMenuBarIconService } from "./background/trayVisibility"
import type { FullRuntime } from "./fullRuntime"
import { loadNativeLanguage } from "./i18n/nativeLanguage"
import { applyMacDockIcon, applyOptionalIcon } from "./identity/appIcon"
import {
  alphaIconNeedsRecolor,
  loadAppIconSelection,
  resolveSelectedAppIconPath,
  resolveStartupAppIcon,
  saveAppIconSelection,
} from "./identity/appIconSelection"
import { createAlphaDockIcon } from "./identity/betaDockIcon"
import { channelDataDir, channelIdentity, resolveAppChannel } from "./identity/channel"
import { FullBootScheduler } from "./quickEdit/fullBootScheduler"
import { firstFileArgument } from "./quickEdit/launchArgs"
import { QuickEditFiles } from "./quickEdit/service"
import { isTestMode } from "./runtime/env"
import { registerAnalysisReportScheme } from "./trpc/science/analysis/reportScheme"
import { publicReleaseFromPackage } from "./updates/release"
import { installAppMenu } from "./window/appMenu"
import { createMainWindow, loadWindowPage } from "./window/mainWindow"
import { installShutdownGuard } from "./window/shutdownGuard"

export type { AppRouter } from "./trpc/appRouter"

/**
 * The small entry starts a file in quick edit before importing fullRuntime.
 * Full services start after the caret is ready or immediately for a full-app
 * request.
 */

// Set the channel before reading userData or opening the database. The packaged
// metadata is injected by electron-builder; source runs use Alpha.
const channel = resolveAppChannel(app.isPackaged, app.getAppPath())
const publicRelease = publicReleaseFromPackage(app.isPackaged, app.getAppPath())
const iconChannel = publicRelease?.channel ?? channel
const identity = channelIdentity(channel)
app.setName(identity.name)
registerAnalysisReportScheme()

// Step 1 — redirect on-disk state before Electron (or the DB) touches the
// default userData path. The local DB and terminal socket follow this same root.
const dataDirOverride = channelDataDir(channel, process.env.PI_LAB_DATA_DIR)
if (dataDirOverride) {
  mkdirSync(dataDirOverride, { recursive: true })
  process.env.PI_LAB_DATA_DIR = dataDirOverride
  app.setPath("userData", dataDirOverride)
}
const menuBarIcon = createMenuBarIconService(() => app.getPath("userData"), process.platform)

const appIconContext = {
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appPath: app.isPackaged ? app.getAppPath() : resolve(__dirname, "../.."),
  channel: iconChannel,
}
const trayTemplatePath = app.isPackaged
  ? join(process.resourcesPath, "trayTemplate.png")
  : resolve(appIconContext.appPath, "assets/icons/trayTemplate.png")
const startupIcon = resolveStartupAppIcon(
  loadAppIconSelection(
    app.getPath("userData"),
    {
      warn: (message) => console.warn(message),
    },
    iconChannel,
  ),
  appIconContext,
  { exists: existsSync },
  { warn: (message) => console.warn(message) },
)
let appIconSelection = startupIcon.selection
let appIconPath = startupIcon.path

/** Apply Alpha's selected palette without changing Finder artwork. */
function currentDockIcon() {
  if (process.platform !== "darwin" || iconChannel !== "alpha") return appIconPath
  if (!alphaIconNeedsRecolor(appIconSelection)) return appIconPath
  const palettePath = app.isPackaged
    ? join(process.resourcesPath, "app-icon-palettes.json")
    : resolve(appIconContext.appPath, "assets/icons/matplotlib-colormaps-3.11.2.json")
  try {
    return createAlphaDockIcon(appIconPath, appIconSelection, palettePath, nativeImage)
  } catch (error) {
    console.warn(`[pi-lab] Selected Dock icon unavailable; using built-in icon: ${String(error)}`)
    return appIconPath
  }
}

/** Apply the selected channel color after the first editor is ready. */
function applySelectedDockIcon(): void {
  if (iconChannel !== "alpha") return
  const dock = app.dock
  applyMacDockIcon(
    currentDockIcon(),
    process.platform,
    dock ? { setIcon: (image) => dock.setIcon(image) } : null,
    { warn: (message) => console.warn(message) },
  )
}

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
let readyUpdateVersion: string | null = null
let restartToUpdate: (() => void) | null = null

/** Include a staged update in the tray's first snapshot and later changes. */
function traySnapshot(): BackgroundTraySnapshot {
  return {
    ...(fullRuntime?.traySnapshot() ?? { projects: [] }),
    updateVersion: readyUpdateVersion,
  }
}

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
  fullRuntime?.boot(window)
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
  if (process.platform === "darwin" && !menuBarIcon.get().visible) {
    hiddenStartup = false
    return
  }
  if (!appIconPath) throw new Error("PI Lab tray icon is missing")
  const { BackgroundTray } = await import("./background/tray")
  if (userWindow || quitting) return
  const created = new BackgroundTray(
    appIconPath,
    identity.name,
    trayTemplatePath,
    {
      openApp: () => openFull(null),
      newProject: () => openFull("/?newProject=1"),
      hideIcon: async () => {
        menuBarIcon.set(false)
        closeTray()
      },
      restartToUpdate: () => restartToUpdate?.(),
      quit: () => app.quit(),
    },
    traySnapshot(),
  )
  tray = created
  hiddenStartup = false
  unsubscribeTray = runtime.subscribeTray((snapshot) =>
    created.publish({ ...snapshot, updateVersion: readyUpdateVersion }),
  )
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
    showUserWindow(window)
    return
  }
  if (window.webContents.isLoadingMainFrame()) {
    window.webContents.once("did-finish-load", () => {
      if (!window.isDestroyed()) window.webContents.send(QUICK_EDIT_OPEN_CHANNEL, target)
    })
  } else {
    window.webContents.send(QUICK_EDIT_OPEN_CHANNEL, target)
  }
  showUserWindow(window)
}

/** Show a window without taking desktop focus during quiet local GUI tests. */
function showUserWindow(window: BrowserWindow): void {
  if (isTestMode && process.env.PI_LAB_TEST_HIDE_WINDOWS === "1") {
    window.showInactive()
    return
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
      showUserWindow(userWindow)
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
// reserved here so future wiring stays gated behind one flag.

const shutdownGuard = installShutdownGuard({
  app,
  ipcMain,
  createRequestId: randomUUID,
  prepareQuit: async () => {
    // Full boot may still be reconciling retained agents when Quit is requested.
    try {
      await fullBootScheduler.startNow()
      return fullRuntime ? fullRuntime.prepareQuit() : true
    } catch (error) {
      dialog.showErrorBox(
        "Could not quit PI Lab",
        `Agent state could not be checked. The app remains open.\n${String(error)}`,
      )
      return false
    }
  },
})
let fullRuntime: FullRuntime | null = null

ipcMain.handle(APP_ICON_GET_CHANNEL, () => appIconSelection)
ipcMain.handle(APP_ICON_IDENTITY_CHANNEL, () => iconChannel)
ipcMain.handle(APP_ICON_PREVIEW_CHANNEL, async (_event, value: unknown) => {
  if (iconChannel !== "alpha") throw new Error("App icon choices are available in Alpha only")
  if (!isAppIconSelection(value)) throw new Error("Invalid app icon selection")
  const selection = value
  const selectedPath = resolveSelectedAppIconPath(selection, appIconContext, { exists: existsSync })
  if (!alphaIconNeedsRecolor(selection)) {
    const png = await readFile(selectedPath)
    return `data:image/png;base64,${png.toString("base64")}`
  }
  if (iconChannel === "alpha") {
    const palettePath = app.isPackaged
      ? join(process.resourcesPath, "app-icon-palettes.json")
      : resolve(appIconContext.appPath, "assets/icons/matplotlib-colormaps-3.11.2.json")
    const png = createAlphaDockIcon(selectedPath, selection, palettePath, nativeImage).toPNG()
    return `data:image/png;base64,${png.toString("base64")}`
  }
  const png = await readFile(selectedPath)
  return `data:image/png;base64,${png.toString("base64")}`
})
ipcMain.handle(APP_ICON_SET_CHANNEL, (_event, value: unknown) => {
  if (iconChannel !== "alpha") throw new Error("App icon choices are available in Alpha only")
  if (!isAppIconSelection(value)) throw new Error("Invalid app icon selection")
  const selection = value
  const selectedPath = resolveSelectedAppIconPath(selection, appIconContext, { exists: existsSync })
  saveAppIconSelection(app.getPath("userData"), selection)
  appIconSelection = selection
  appIconPath = selectedPath
  const dock = app.dock
  applyMacDockIcon(
    currentDockIcon(),
    process.platform,
    dock ? { setIcon: dock.setIcon.bind(dock) } : null,
    { warn: (message) => console.warn(message) },
  )
  applyOptionalIcon(
    "window",
    selectedPath,
    userWindow && !userWindow.isDestroyed()
      ? { setIcon: (path) => userWindow?.setIcon(path) }
      : null,
    { warn: (message) => console.warn(message) },
  )
  applyOptionalIcon(
    "tray",
    selectedPath,
    tray ? { setIcon: (path) => tray?.setIcon(path) } : null,
    { warn: (message) => console.warn(message) },
  )
  return selection
})

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
        getAppIconPath: () => appIconPath,
        ensureMainWindow,
        openAgentSettings: () => {
          void openFull("/settings?section=agents")
        },
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
      if (publicRelease && !isTestMode && process.platform === "darwin") {
        void import("./updates/start")
          .then(({ startPublicUpdates }) =>
            startPublicUpdates(shutdownGuard, (status, restart) => {
              readyUpdateVersion = status.kind === "ready" ? status.version : null
              restartToUpdate = status.kind === "ready" ? restart : null
              tray?.publish(traySnapshot())
            }),
          )
          .catch((error: unknown) => {
            console.error("[pi-lab] public update checks failed:", error)
          })
      }
      if (quickWindow && userWindow && !userWindow.isDestroyed()) {
        userWindow.webContents.send(QUICK_EDIT_EDITOR_VIM_CHANNEL, runtime.editorVim())
      }
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
  showUserWindow(window)
}

ipcMain.handle(BACKGROUND_TRAY_SNAPSHOT_CHANNEL, () => traySnapshot())
ipcMain.handle(BACKGROUND_TRAY_OPEN_PROJECT_CHANNEL, async (_event, id: unknown) => {
  if (typeof id !== "string" || !fullRuntime?.hasProject(id)) throw new Error("Unknown project")
  await openFull(`/projects/${encodeURIComponent(id)}`)
})
async function openFileFromTray(): Promise<void> {
  const testFile = isTestMode ? process.env.PI_LAB_TEST_PICK_FILE : undefined
  if (testFile) {
    acceptFile(testFile)
    return
  }
  const result = await dialog.showOpenDialog({ properties: ["openFile"] })
  if (!result.canceled && result.filePaths[0]) acceptFile(result.filePaths[0])
}
ipcMain.handle(BACKGROUND_TRAY_OPEN_FILE_CHANNEL, openFileFromTray)
ipcMain.on(BACKGROUND_TRAY_RESTART_TO_UPDATE_CHANNEL, () => restartToUpdate?.())

ipcMain.handle(QUICK_EDIT_CURRENT_CHANNEL, () => quickFiles.current())
ipcMain.handle(QUICK_EDIT_PYTHON_OPTIONS_CHANNEL, async (_event, id: unknown) => {
  if (typeof id !== "string") throw new Error("Invalid quick-edit file ID")
  const path = quickFiles.canonicalPath(id)
  await fullBootScheduler.startNow()
  if (!fullRuntime) throw new Error("Full app did not start")
  return fullRuntime.quickPythonOptions(path)
})
ipcMain.handle(QUICK_EDIT_PYTHON_SELECT_CHANNEL, async (_event, id: unknown, path: unknown) => {
  if (typeof id !== "string" || (path !== null && typeof path !== "string")) {
    throw new Error("Invalid quick-edit Python environment selection")
  }
  const filePath = quickFiles.canonicalPath(id)
  await fullBootScheduler.startNow()
  if (!fullRuntime) throw new Error("Full app did not start")
  return fullRuntime.quickPythonSelect(filePath, path)
})
ipcMain.handle(
  QUICK_EDIT_PYTHON_RUN_CHANNEL,
  async (_event, id: unknown, cols: unknown, rows: unknown) => {
    if (typeof id !== "string" || typeof cols !== "number" || typeof rows !== "number") {
      throw new Error("Invalid quick-edit Python run request")
    }
    const path = quickFiles.canonicalPath(id)
    await fullBootScheduler.startNow()
    if (!fullRuntime) throw new Error("Full app did not start")
    return fullRuntime.quickPythonRun(path, cols, rows)
  },
)
ipcMain.handle(QUICK_EDIT_PYTHON_KILL_CHANNEL, async (_event, sessionId: unknown) => {
  if (typeof sessionId !== "string") throw new Error("Invalid quick-edit Python session ID")
  if (!fullRuntime) throw new Error("Full app did not start")
  await fullRuntime.quickPythonKill(sessionId)
})
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
ipcMain.handle(QUICK_EDIT_SAVE_UNTITLED_CHANNEL, async (_event, content: unknown) => {
  if (typeof content !== "string") throw new Error("Invalid untitled editor content")
  await fullBootScheduler.startNow()
  if (!fullRuntime) throw new Error("Full app did not start")
  const testPath = isTestMode ? process.env.PI_LAB_TEST_SAVE_FILE_PATH?.trim() : undefined
  const options = { title: "Save Editor File" }
  const result = testPath
    ? { canceled: false, filePath: testPath }
    : userWindow && !userWindow.isDestroyed()
      ? await dialog.showSaveDialog(userWindow, options)
      : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  const path = await quickFiles.saveUntitled(result.filePath, content)
  const target = quickFiles.register(path)
  return { path, route: fullRuntime.routeForFile(target) }
})
ipcMain.on(QUICK_EDIT_READY_CHANNEL, () => {
  if (quickWindow) {
    fullBootScheduler.schedule()
    setImmediate(applySelectedDockIcon)
  }
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
ipcMain.handle(QUICK_EDIT_SHOW_SETTINGS_CHANNEL, async (_event, id: unknown) => {
  if (id !== null && typeof id !== "string") throw new Error("Invalid quick-edit file ID")
  const target = id === null ? null : quickFiles.require(id)
  await fullBootScheduler.startNow()
  if (!fullRuntime) throw new Error("Full app did not start")
  const window = ensureMainWindow()
  const returnTarget = target ? `&returnTarget=${encodeURIComponent(target.id)}` : ""
  await loadWindowPage(window, "full", `/settings?section=quick-editor${returnTarget}`)
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
    applySelectedDockIcon()
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
