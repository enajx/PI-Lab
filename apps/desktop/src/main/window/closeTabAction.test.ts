import { EventEmitter } from "node:events"
import type { BrowserWindow, IpcMain } from "electron"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { CLOSE_TAB_REQUEST_CHANNEL, CLOSE_TAB_RESPONSE_CHANNEL } from "../../shared/closeTab"
import { installCloseTabAction } from "./closeTabAction"

/** Mocked Electron window and IPC. The real menu-to-renderer path is covered by E2E. */
function harness(withWindow: boolean) {
  const ipc = new EventEmitter()
  const mainFrame = {}
  const destroyed = { window: false, contents: false }
  const webContents = {
    mainFrame,
    send: vi.fn(),
    isDestroyed: () => destroyed.contents,
    isCrashed: () => false,
  }
  const window = {
    webContents,
    isDestroyed: () => destroyed.window,
  } as unknown as BrowserWindow
  const hide = vi.fn()
  const warn = vi.fn()
  let sequence = 0
  const action = installCloseTabAction({
    ipcMain: ipc as IpcMain,
    targetWindow: () => (withWindow ? window : null),
    hide,
    warn,
    createRequestId: () => `request-${++sequence}`,
    timeoutMs: 1_000,
  })
  const respond = (value: unknown, sender: unknown, senderFrame: unknown): void => {
    ipc.emit(CLOSE_TAB_RESPONSE_CHANNEL, { sender, senderFrame }, value)
  }
  return { ipc, webContents, mainFrame, destroyed, hide, warn, action, respond }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("Cmd+W close-tab action through mocked Electron", () => {
  test("hides the app at once when there is no PI Lab window to ask", () => {
    const h = harness(false)
    h.action.request()
    expect(h.hide).toHaveBeenCalledOnce()
  })

  test("hides the app at once when the focused renderer is gone", () => {
    const h = harness(true)
    h.destroyed.contents = true
    h.action.request()
    expect(h.hide).toHaveBeenCalledOnce()
    expect(h.webContents.send).not.toHaveBeenCalled()
  })

  test("asks the focused renderer and keeps the app visible when it closes a tab", () => {
    const h = harness(true)
    h.action.request()
    expect(h.webContents.send).toHaveBeenCalledExactlyOnceWith(CLOSE_TAB_REQUEST_CHANNEL, {
      requestId: "request-1",
    })
    h.respond({ requestId: "request-1", handled: true }, h.webContents, h.mainFrame)
    vi.advanceTimersByTime(5_000)
    expect(h.hide).not.toHaveBeenCalled()
  })

  test("hides the app when the renderer has no tab to close", () => {
    const h = harness(true)
    h.action.request()
    h.respond({ requestId: "request-1", handled: false }, h.webContents, h.mainFrame)
    expect(h.hide).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(5_000)
    expect(h.hide).toHaveBeenCalledOnce()
  })

  test("hides the app and warns when the renderer does not answer, ignoring a late answer", () => {
    const h = harness(true)
    h.action.request()
    vi.advanceTimersByTime(999)
    expect(h.hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(h.hide).toHaveBeenCalledOnce()
    expect(h.warn).toHaveBeenCalledOnce()
    h.respond({ requestId: "request-1", handled: false }, h.webContents, h.mainFrame)
    expect(h.hide).toHaveBeenCalledOnce()
  })

  test("ignores answers from another sender, frame or request, and repeated presses while waiting", () => {
    const h = harness(true)
    h.action.request()
    h.action.request()
    expect(h.webContents.send).toHaveBeenCalledOnce()
    h.respond({ requestId: "request-1", handled: false }, {}, h.mainFrame)
    h.respond({ requestId: "request-1", handled: false }, h.webContents, {})
    h.respond({ requestId: "other", handled: false }, h.webContents, h.mainFrame)
    h.respond({ requestId: "request-1" }, h.webContents, h.mainFrame)
    expect(h.hide).not.toHaveBeenCalled()
    h.respond({ requestId: "request-1", handled: true }, h.webContents, h.mainFrame)
    h.action.request()
    expect(h.webContents.send).toHaveBeenLastCalledWith(CLOSE_TAB_REQUEST_CHANNEL, {
      requestId: "request-2",
    })
  })

  test("dispose stops listening and cancels a pending fallback", () => {
    const h = harness(true)
    h.action.request()
    h.action.dispose()
    expect(h.ipc.listenerCount(CLOSE_TAB_RESPONSE_CHANNEL)).toBe(0)
    vi.advanceTimersByTime(5_000)
    expect(h.hide).not.toHaveBeenCalled()
  })
})
