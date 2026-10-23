import { join } from "node:path"
import { BrowserWindow, dialog, Menu, nativeImage, type Rectangle, screen, Tray } from "electron"
import {
  BACKGROUND_TRAY_CHANGED_CHANNEL,
  type BackgroundTraySnapshot,
} from "../../shared/backgroundTray"
import { isTestMode, rendererDevServerUrl } from "../runtime/env"
import { type TrayMenuActions, trayMenuTemplate } from "./trayMenu"

const POPOVER_WIDTH = 240
const MAX_VISIBLE_PROJECTS = 6

function popoverHeight(snapshot: BackgroundTraySnapshot): number {
  const projectHeight = snapshot.projects.length
    ? Math.min(snapshot.projects.length, MAX_VISIBLE_PROJECTS) * 39 + 6
    : 39
  return 33 + projectHeight + (snapshot.updateVersion ? 44 : 0)
}

/** Keep the menu-bar icon alive while PI Lab runs, including with its main window open. */
export class BackgroundTray {
  private readonly tray: Tray
  private popover: BrowserWindow | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private snapshot: BackgroundTraySnapshot

  constructor(
    iconPath: string,
    appName: string,
    private readonly templatePath: string,
    private readonly actions: TrayMenuActions,
    private readonly readSnapshot: () => BackgroundTraySnapshot,
  ) {
    this.snapshot = readSnapshot()
    this.tray = new Tray(this.imageFor(iconPath))
    this.tray.setToolTip(appName)
    this.tray.on("click", (_event, bounds) => this.toggle(bounds))
    if (process.platform === "linux") this.tray.setContextMenu(this.menu())
    else
      this.tray.on("right-click", () => {
        this.popover?.hide()
        this.tray.popUpContextMenu(this.menu())
      })
  }

  /** Update the background icon when Settings changes the application icon. */
  setIcon(iconPath: string): void {
    if (process.platform !== "darwin") this.tray.setImage(this.imageFor(iconPath))
  }

  private imageFor(iconPath: string) {
    const path = process.platform === "darwin" ? this.templatePath : iconPath
    const source = nativeImage.createFromPath(path)
    if (source.isEmpty()) throw new Error(`PI Lab tray icon could not be loaded: ${path}`)
    const icon = process.platform === "darwin" ? source : source.resize({ width: 20, height: 20 })
    if (process.platform === "darwin") icon.setTemplateImage(true)
    return icon
  }

  private menu(): Menu {
    return Menu.buildFromTemplate(
      trayMenuTemplate(this.actions, this.snapshot.updateVersion ?? null, (label, error) => {
        console.error(`[pi-lab] ${label} failed:`, error)
        dialog.showErrorBox(`${label} failed`, String(error))
      }),
    )
  }

  /** Hide the popover after one of its actions opens a window. */
  hide(): void {
    this.popover?.hide()
  }

  /** Send a fresh project list to an already loaded popover. */
  publish(snapshot: BackgroundTraySnapshot): void {
    this.snapshot = snapshot
    if (process.platform === "linux") this.tray.setContextMenu(this.menu())
    const window = this.popover
    if (!window || window.isDestroyed()) return
    window.setSize(POPOVER_WIDTH, popoverHeight(snapshot))
    if (window.webContents.isLoadingMainFrame()) return
    window.webContents.send(BACKGROUND_TRAY_CHANGED_CHANNEL, snapshot)
  }

  /** Open the same popover without a pointer event for the desktop smoke test. */
  showForTest(): void {
    if (this.popover?.isVisible()) return
    const point = screen.getCursorScreenPoint()
    this.toggle({ x: point.x, y: point.y, width: 0, height: 0 })
  }

  /** Remove OS resources during an explicit quit. */
  dispose(): void {
    this.stopRefreshing()
    this.popover?.destroy()
    this.popover = null
    this.tray.destroy()
  }

  private toggle(bounds: Rectangle): void {
    const window = this.ensurePopover()
    if (window.isVisible()) {
      window.hide()
      return
    }
    this.publish(this.readSnapshot())
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const area = display.workArea
    const height = popoverHeight(this.snapshot)
    window.setSize(POPOVER_WIDTH, height)
    const anchor = bounds.width > 0 ? bounds : { ...bounds, x: screen.getCursorScreenPoint().x }
    const x = Math.min(
      Math.max(anchor.x + anchor.width / 2 - POPOVER_WIDTH / 2, area.x),
      area.x + area.width - POPOVER_WIDTH,
    )
    const below = anchor.y + anchor.height + height <= area.y + area.height
    const y = below ? anchor.y + anchor.height : anchor.y - height
    window.setPosition(Math.round(x), Math.round(Math.max(area.y, y)))
    if (isTestMode && process.env.PI_LAB_TEST_HIDE_WINDOWS === "1") window.showInactive()
    else {
      window.show()
      window.focus()
    }
  }

  /** Poll only while visible, including activity that has no live terminal session. */
  private stopRefreshing(): void {
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer)
    this.refreshTimer = null
  }

  private ensurePopover(): BrowserWindow {
    if (this.popover && !this.popover.isDestroyed()) return this.popover
    const window = new BrowserWindow({
      width: POPOVER_WIDTH,
      height: popoverHeight(this.snapshot),
      show: false,
      ...(isTestMode && process.env.PI_LAB_TEST_HIDE_WINDOWS === "1" ? { opacity: 0 } : {}),
      // macOS panels take keyboard focus without activating the full application.
      ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: "#f8f8f6",
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    if (isTestMode && process.env.PI_LAB_TEST_HIDE_WINDOWS === "1") {
      window.setIgnoreMouseEvents(true)
    }
    window.on("blur", () => window.hide())
    window.on("show", () => {
      this.stopRefreshing()
      this.refreshTimer = setInterval(() => this.publish(this.readSnapshot()), 1000)
    })
    window.on("hide", () => this.stopRefreshing())
    window.on("closed", () => {
      this.stopRefreshing()
      if (this.popover === window) this.popover = null
    })
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    window.webContents.on("will-navigate", (event) => event.preventDefault())
    if (rendererDevServerUrl) {
      void window.loadURL(new URL("tray.html", rendererDevServerUrl).toString())
    } else {
      void window.loadFile(join(__dirname, "../renderer/tray.html"))
    }
    this.popover = window
    return window
  }
}
