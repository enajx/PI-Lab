import type { App, BrowserWindow, Event, IpcMain, IpcMainEvent } from "electron"
import {
  isShutdownResponse,
  SHUTDOWN_REQUEST_CHANNEL,
  SHUTDOWN_RESPONSE_CHANNEL,
  type ShutdownRequest,
} from "../../shared/shutdown"
import type { QuitMode } from "../agents/quitPolicy"

interface ShutdownGuardOptions {
  app: Pick<App, "on" | "removeListener" | "quit">
  ipcMain: Pick<IpcMain, "on" | "removeListener">
  createRequestId: () => string
  /** Apply the quit mode to agents and terminals after draft approval. */
  prepareQuit?: (mode: QuitMode) => Promise<boolean>
  /**
   * Called on a user window close. Returning true keeps the window open and sends
   * no close request: the caller runs its own quit flow instead.
   */
  interceptClose?: () => boolean
}

export interface ShutdownGuard {
  attachWindow: (window: BrowserWindow) => void
  requestExplicitQuit: () => void
  /**
   * Explicit Quit that runs `stop` (stop the server and agents) after the
   * renderer approved its unsaved drafts and before the app quits. A
   * cancelled draft prompt runs nothing.
   */
  requestExplicitQuitAndStop: (stop: () => Promise<void>) => void
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
  /** Work the pending explicit Quit runs once approved (Stop Server and Agents). */
  let pendingStop: (() => Promise<void>) | null = null

  /** Run asynchronous agent shutdown once; rejection never grants approval. */
  function prepareAndQuit(
    install: (() => void) | null,
    mode: QuitMode,
    stop: (() => Promise<void>) | null,
  ): void {
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
    const prepare = options.prepareQuit
    if (!prepare && !stop) {
      finish()
      return
    }
    preparingQuit = true
    void (prepare ? prepare(mode) : Promise.resolve(true))
      .then((allow) => {
        if (allow && stop) {
          return stop().then(() => {
            preparingQuit = false
            finish()
          })
        }
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
        prepareAndQuit(installOnApprovedQuit, "confirm-end", null)
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
    if (options.interceptClose?.()) return
    request("close")
  }

  function detachWindow(): void {
    mainWindow?.removeListener("close", beforeClose)
    mainWindow?.removeListener("closed", detachWindow)
    mainWindow = null
    pending = null
    pendingStopConfirmed = false
    pendingStop = null
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
    const stop = pendingStop
    pendingStopConfirmed = false
    pendingStop = null
    pending = null
    if (!value.allow) {
      pendingUpdateInstall = null
      return
    }
    if (intent === "quit") {
      const update = pendingUpdateInstall
      pendingUpdateInstall = null
      // Explicit Quit ends everything (and installs a ready update); Restart to
      // Update keeps work running; any other quit asks when work is running.
      const mode: QuitMode = stopConfirmed ? "end" : update ? "keep" : "confirm-end"
      prepareAndQuit(update ?? installOnApprovedQuit, mode, update ? null : stop)
    } else {
      approvedClose = window
      window.close()
    }
  }

  /** Explicit Quit; `stop` runs after the draft approval, before the app quits. */
  function explicitQuit(stop: (() => Promise<void>) | null): void {
    if (pending?.intent === "quit" || preparingQuit) return
    if (!mainWindow || mainWindow.isDestroyed()) {
      prepareAndQuit(installOnApprovedQuit, "end", stop)
      return
    }
    if (mainWindow.webContents.isDestroyed()) return
    pendingStopConfirmed = true
    pendingStop = stop
    request("quit")
  }

  options.app.on("before-quit", beforeQuit)
  options.app.on("will-quit", willQuit)
  options.ipcMain.on(SHUTDOWN_RESPONSE_CHANNEL, receiveResponse)

  return {
    isQuitPending: () => pending?.intent === "quit" || preparingQuit || approvedQuit !== null,
    requestExplicitQuit(): void {
      explicitQuit(null)
    },
    requestExplicitQuitAndStop(stop): void {
      explicitQuit(stop)
    },
    requestUpdateInstall(install): void {
      // Stop Server and Agents waits for the drafts answer; it is not turned
      // into a Restart to Update. The update stays ready for the next launch.
      if (pendingStop) {
        console.warn("[pi-lab] update install ignored: Stop Server and Agents is pending")
        return
      }
      if (!mainWindow || mainWindow.isDestroyed()) {
        prepareAndQuit(install, "keep", null)
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
