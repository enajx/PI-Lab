import { join } from "node:path"
import { BrowserWindow, nativeImage, type Rectangle, screen, Tray } from "electron"
import { BACKGROUND_TRAY_CHANGED_CHANNEL } from "../../shared/backgroundTray"
import { isTestMode, rendererDevServerUrl } from "../runtime/env"

const POPOVER_WIDTH = 344
const POPOVER_HEIGHT = 420

/** Keep the icon and its small renderer alive while PI Lab runs in the background. */
export class BackgroundTray {
  private readonly tray: Tray
  private popover: BrowserWindow | null = null

  constructor(iconPath: string, appName: string) {
    this.tray = new Tray(this.imageFor(iconPath))
    this.tray.setToolTip(appName)
    this.tray.on("click", (_event, bounds) => this.toggle(bounds))
  }

  /** Update the background icon when Settings changes the application icon. */
  setIcon(iconPath: string): void {
    this.tray.setImage(this.imageFor(iconPath))
  }

  private imageFor(iconPath: string) {
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 })
    if (icon.isEmpty()) throw new Error(`PI Lab tray icon could not be loaded: ${iconPath}`)
    if (process.platform === "darwin") icon.setTemplateImage(true)
    return icon
  }

  /** Hide the popover after one of its actions opens a window. */
  hide(): void {
    this.popover?.hide()
  }

  /** Send a fresh project list to an already loaded popover. */
  publish(snapshot: unknown): void {
    const window = this.popover
    if (!window || window.isDestroyed() || window.webContents.isLoadingMainFrame()) return
    window.webContents.send(BACKGROUND_TRAY_CHANGED_CHANNEL, snapshot)
  }

  /** Open the same popover without a pointer event for the desktop smoke test. */
  showForTest(): void {
    const point = screen.getCursorScreenPoint()
    this.toggle({ x: point.x, y: point.y, width: 0, height: 0 })
  }

  /** Remove OS resources during an explicit quit. */
  dispose(): void {
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
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const area = display.workArea
    const anchor = bounds.width > 0 ? bounds : { ...bounds, x: screen.getCursorScreenPoint().x }
    const x = Math.min(
      Math.max(anchor.x + anchor.width / 2 - POPOVER_WIDTH / 2, area.x),
      area.x + area.width - POPOVER_WIDTH,
    )
    const below = anchor.y + anchor.height + POPOVER_HEIGHT <= area.y + area.height
    const y = below ? anchor.y + anchor.height : anchor.y - POPOVER_HEIGHT
    window.setPosition(Math.round(x), Math.round(Math.max(area.y, y)))
    if (isTestMode && process.env.PI_LAB_TEST_HIDE_WINDOWS === "1") window.showInactive()
    else {
      window.show()
      window.focus()
    }
  }

  private ensurePopover(): BrowserWindow {
    if (this.popover && !this.popover.isDestroyed()) return this.popover
    const window = new BrowserWindow({
      width: POPOVER_WIDTH,
      height: POPOVER_HEIGHT,
      show: false,
      ...(isTestMode && process.env.PI_LAB_TEST_HIDE_WINDOWS === "1" ? { opacity: 0 } : {}),
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
    window.on("closed", () => {
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
