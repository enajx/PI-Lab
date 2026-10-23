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
  /** Confirm the agent policy and finish stopping agents after draft approval. */
  prepareQuit?: (stopConfirmed: boolean) => Promise<boolean>
}

export interface ShutdownGuard {
  attachWindow: (window: BrowserWindow) => void
  requestExplicitQuit: () => void
  isQuitPending: () => boolean
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
  let preparingQuit = false
  let pendingStopConfirmed = false

  /** Run asynchronous agent shutdown once; rejection never grants approval. */
  function prepareAndQuit(install: (() => void) | null, stopConfirmed: boolean): void {
    if (preparingQuit) return
    const finish = () => {
      if (install) {
        beginApprovedUpdateInstall(install)
        return
      }
      const approval: { event: Event | null; update: boolean } = { event: null, update: false }
      approvedQuit = approval
      try {
        options.app.quit()
      } finally {
        if (approvedQuit === approval && (!approval.event || approval.event.defaultPrevented)) {
          approvedQuit = null
        }
      }
    }
    if (!options.prepareQuit) {
      finish()
      return
    }
    preparingQuit = true
    void options
      .prepareQuit(stopConfirmed)
      .then((allow) => {
        preparingQuit = false
        if (allow) finish()
      })
      .catch((error) => {
        preparingQuit = false
        console.error("[pi-lab] agent shutdown failed; quit cancelled", error)
      })
  }

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
    if (preparingQuit) {
      event.preventDefault()
      return
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (installOnApprovedQuit || options.prepareQuit) {
        event.preventDefault()
        prepareAndQuit(installOnApprovedQuit, false)
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
    pendingStopConfirmed = false
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
    const stopConfirmed = pendingStopConfirmed
    pendingStopConfirmed = false
    pending = null
    if (!value.allow) {
      pendingUpdateInstall = null
      return
    }
    if (intent === "quit") {
      const install = pendingUpdateInstall ?? installOnApprovedQuit
      pendingUpdateInstall = null
      prepareAndQuit(install, stopConfirmed)
    } else {
      approvedClose = window
      window.close()
    }
  }

  options.app.on("before-quit", beforeQuit)
  options.app.on("will-quit", willQuit)
  options.ipcMain.on(SHUTDOWN_RESPONSE_CHANNEL, receiveResponse)

  return {
    isQuitPending: () => pending?.intent === "quit" || preparingQuit || approvedQuit !== null,
    requestExplicitQuit(): void {
      if (pending?.intent === "quit" || preparingQuit) return
      if (!mainWindow || mainWindow.isDestroyed()) {
        prepareAndQuit(installOnApprovedQuit, true)
        return
      }
      if (mainWindow.webContents.isDestroyed()) return
      pendingStopConfirmed = true
      request("quit")
    },
    requestUpdateInstall(install): void {
      if (!mainWindow || mainWindow.isDestroyed()) {
        prepareAndQuit(install, false)
        return
      }
      if (mainWindow.webContents.isDestroyed()) return
      pendingStopConfirmed = false
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
