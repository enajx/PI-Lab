import type { App, BrowserWindow, Event, IpcMain, IpcMainEvent } from "electron"
import {
  isShutdownResponse,
  SHUTDOWN_REQUEST_CHANNEL,
  SHUTDOWN_RESPONSE_CHANNEL,
  type ShutdownRequest,
} from "../../shared/shutdown"

interface ShutdownGuardOptions {
  app: Pick<App, "on" | "removeListener" | "quit">
  ipcMain: Pick<IpcMain, "on" | "removeListener">
  createRequestId: () => string
}

export interface ShutdownGuard {
  attachWindow: (window: BrowserWindow) => void
  dispose: () => void
}

/** Protect normal window close and app quit until the renderer approves them. */
export function installShutdownGuard(options: ShutdownGuardOptions): ShutdownGuard {
  let mainWindow: BrowserWindow | null = null
  let pending: ShutdownRequest | null = null
  let approvedQuit: { event: Event | null } | null = null
  let approvedClose: BrowserWindow | null = null

  function request(intent: ShutdownRequest["intent"]): void {
    if (!mainWindow || mainWindow.webContents.isDestroyed()) return
    if (pending) {
      if (intent === "quit") pending = { ...pending, intent: "quit" }
    } else {
      pending = { requestId: options.createRequestId(), intent }
    }
    mainWindow.webContents.send(SHUTDOWN_REQUEST_CHANNEL, pending)
  }

  function beforeQuit(event: Event): void {
    if (approvedQuit && !approvedQuit.event) {
      approvedQuit.event = event
      return
    }
    approvedQuit = null
    if (!mainWindow || mainWindow.isDestroyed()) return
    event.preventDefault()
    request("quit")
  }

  function beforeClose(event: Event): void {
    if (approvedQuit?.event && !approvedQuit.event.defaultPrevented) {
      approvedQuit = null
      return
    }
    if (approvedClose === mainWindow) {
      approvedClose = null
      return
    }
    event.preventDefault()
    request("close")
  }

  function detachWindow(): void {
    mainWindow?.removeListener("close", beforeClose)
    mainWindow?.removeListener("closed", detachWindow)
    mainWindow = null
    pending = null
    approvedQuit = null
    approvedClose = null
  }

  function receiveResponse(event: IpcMainEvent, value: unknown): void {
    const window = mainWindow
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      !pending ||
      !isShutdownResponse(value) ||
      value.requestId !== pending.requestId ||
      event.sender !== window.webContents ||
      !event.senderFrame ||
      event.senderFrame !== window.webContents.mainFrame
    )
      return

    const intent = pending.intent
    pending = null
    if (!value.allow) return
    if (intent === "quit") {
      const approval: { event: Event | null } = { event: null }
      approvedQuit = approval
      options.app.quit()
      // Another before-quit listener may cancel this attempt without a close.
      if (approvedQuit === approval && (!approval.event || approval.event.defaultPrevented)) {
        approvedQuit = null
      }
    } else {
      approvedClose = window
      window.close()
    }
  }

  options.app.on("before-quit", beforeQuit)
  options.ipcMain.on(SHUTDOWN_RESPONSE_CHANNEL, receiveResponse)

  return {
    attachWindow(window): void {
      if (window === mainWindow) return
      detachWindow()
      mainWindow = window
      window.on("close", beforeClose)
      window.on("closed", detachWindow)
    },
    dispose(): void {
      detachWindow()
      options.app.removeListener("before-quit", beforeQuit)
      options.ipcMain.removeListener(SHUTDOWN_RESPONSE_CHANNEL, receiveResponse)
    },
  }
}
