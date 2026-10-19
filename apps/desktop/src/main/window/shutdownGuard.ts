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
  requestUpdateInstall: (install: () => void) => void
  setInstallOnApprovedQuit: (install: (() => void) | null) => void
  cancelUpdateInstall: () => void
  dispose: () => void
}

/** Protect normal window close and app quit until the renderer approves them. */
export function installShutdownGuard(options: ShutdownGuardOptions): ShutdownGuard {
  let mainWindow: BrowserWindow | null = null
  let pending: ShutdownRequest | null = null
  let approvedQuit: { event: Event | null; update: boolean } | null = null
  let approvedClose: BrowserWindow | null = null
  let pendingUpdateInstall: (() => void) | null = null
  let installOnApprovedQuit: (() => void) | null = null

  /** Keep approval across asynchronous updater work until quit or explicit failure. */
  function beginApprovedUpdateInstall(install: () => void): void {
    const approval = { event: null, update: true }
    approvedQuit = approval
    let started = false
    try {
      install()
      started = true
    } finally {
      if (!started && approvedQuit === approval) approvedQuit = null
    }
  }

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
    if (approvedQuit?.update) {
      approvedQuit.event = event
      return
    }
    if (approvedQuit && !approvedQuit.event) {
      approvedQuit.event = event
      return
    }
    approvedQuit = null
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (installOnApprovedQuit) {
        event.preventDefault()
        beginApprovedUpdateInstall(installOnApprovedQuit)
      }
      return
    }
    event.preventDefault()
    request("quit")
  }

  function beforeClose(event: Event): void {
    if (approvedQuit?.update) return
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
    if (!approvedQuit?.update) approvedQuit = null
    approvedClose = null
    pendingUpdateInstall = null
  }

  function willQuit(): void {
    approvedQuit = null
    pendingUpdateInstall = null
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
    if (!value.allow) {
      pendingUpdateInstall = null
      return
    }
    if (intent === "quit") {
      const install = pendingUpdateInstall ?? installOnApprovedQuit
      pendingUpdateInstall = null
      if (install) {
        beginApprovedUpdateInstall(install)
        return
      }
      const approval: { event: Event | null; update: boolean } = { event: null, update: false }
      approvedQuit = approval
      try {
        options.app.quit()
      } finally {
        // The approved action must start quitting synchronously. An exception,
        // cancelled quit, or callback that does not quit cannot approve a later attempt.
        if (approvedQuit === approval && (!approval.event || approval.event.defaultPrevented)) {
          approvedQuit = null
        }
      }
    } else {
      approvedClose = window
      window.close()
    }
  }

  options.app.on("before-quit", beforeQuit)
  options.app.on("will-quit", willQuit)
  options.ipcMain.on(SHUTDOWN_RESPONSE_CHANNEL, receiveResponse)

  return {
    requestUpdateInstall(install): void {
      if (!mainWindow || mainWindow.isDestroyed()) {
        beginApprovedUpdateInstall(install)
        return
      }
      if (mainWindow.webContents.isDestroyed()) return
      pendingUpdateInstall = install
      request("quit")
    },
    setInstallOnApprovedQuit(install): void {
      installOnApprovedQuit = install
    },
    cancelUpdateInstall(): void {
      const explicitUpdatePending = pendingUpdateInstall !== null
      pendingUpdateInstall = null
      if (approvedQuit?.update) approvedQuit = null
      if (explicitUpdatePending && pending?.intent === "quit") pending = null
    },
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
      options.app.removeListener("will-quit", willQuit)
      options.ipcMain.removeListener(SHUTDOWN_RESPONSE_CHANNEL, receiveResponse)
    },
  }
}
