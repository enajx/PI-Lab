import type { BrowserWindow, IpcMain, IpcMainEvent } from "electron"
import {
  CLOSE_TAB_REQUEST_CHANNEL,
  CLOSE_TAB_RESPONSE_CHANNEL,
  isCloseTabResponse,
} from "../../shared/closeTab"

interface CloseTabActionOptions {
  ipcMain: Pick<IpcMain, "on" | "removeListener">
  /** The PI Lab user window Cmd+W applies to, or null when there is none to ask. */
  targetWindow: () => BrowserWindow | null
  /** Move the app to the background (macOS `app.hide()`). */
  hide: () => void
  warn: (message: string) => void
  createRequestId: () => string
  /** How long to wait for the renderer before falling back to `hide`. */
  timeoutMs: number
}

export interface CloseTabAction {
  /** Handle one Cmd+W press: the renderer closes a file tab or the app hides. */
  request: () => void
  dispose: () => void
}

interface PendingRequest {
  requestId: string
  window: BrowserWindow
  timer: ReturnType<typeof setTimeout>
}

/**
 * Cmd+W asks the user window's renderer whether it closes a file tab. A
 * "not handled" answer, a missing renderer, or no answer in time hides the app,
 * so the shortcut never does nothing. One request is in flight at a time;
 * presses while it waits are ignored, and late answers are dropped.
 */
export function installCloseTabAction(options: CloseTabActionOptions): CloseTabAction {
  let pending: PendingRequest | null = null

  function settle(): void {
    if (pending) clearTimeout(pending.timer)
    pending = null
  }

  function receiveResponse(event: IpcMainEvent, value: unknown): void {
    const current = pending
    if (
      !current ||
      !isCloseTabResponse(value) ||
      value.requestId !== current.requestId ||
      current.window.isDestroyed() ||
      current.window.webContents.isDestroyed() ||
      event.sender !== current.window.webContents ||
      !event.senderFrame ||
      event.senderFrame !== current.window.webContents.mainFrame
    )
      return
    settle()
    if (!value.handled) options.hide()
  }

  options.ipcMain.on(CLOSE_TAB_RESPONSE_CHANNEL, receiveResponse)

  return {
    request(): void {
      if (pending) return
      const window = options.targetWindow()
      if (
        !window ||
        window.isDestroyed() ||
        window.webContents.isDestroyed() ||
        window.webContents.isCrashed()
      ) {
        options.hide()
        return
      }
      const requestId = options.createRequestId()
      const timer = setTimeout(() => {
        if (pending?.requestId !== requestId) return
        pending = null
        options.warn("[pi-lab] Cmd+W: the window did not answer; moving to the background")
        options.hide()
      }, options.timeoutMs)
      pending = { requestId, window, timer }
      window.webContents.send(CLOSE_TAB_REQUEST_CHANNEL, { requestId })
    },
    dispose(): void {
      settle()
      options.ipcMain.removeListener(CLOSE_TAB_RESPONSE_CHANNEL, receiveResponse)
    },
  }
}
