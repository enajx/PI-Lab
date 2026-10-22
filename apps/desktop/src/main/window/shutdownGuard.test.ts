import { EventEmitter } from "node:events"
import type { App, BrowserWindow, IpcMain } from "electron"
import { describe, expect, test, vi } from "vitest"
import { SHUTDOWN_REQUEST_CHANNEL, SHUTDOWN_RESPONSE_CHANNEL } from "../../shared/shutdown"
import { installShutdownGuard } from "./shutdownGuard"

/** Mocked Electron public events. Real Electron shutdown is checked by the E2E flow. */
function harness(prepareQuit?: () => Promise<boolean>) {
  const app = new EventEmitter()
  const ipc = new EventEmitter()
  const window = new EventEmitter()
  const mainFrame = {}
  const webContents = { mainFrame, send: vi.fn(), isDestroyed: vi.fn(() => false) }
  const unload = { blocked: false }
  const close = vi.fn(() => {
    const event = {
      defaultPrevented: false,
      preventDefault: vi.fn(() => {
        event.defaultPrevented = true
      }),
    }
    window.emit("close", event)
    const allowed = !event.defaultPrevented && !unload.blocked
    if (allowed) window.emit("closed")
    return allowed
  })
  const quit = vi.fn(() => {
    const event = {
      defaultPrevented: false,
      preventDefault: vi.fn(() => {
        event.defaultPrevented = true
      }),
    }
    app.emit("before-quit", event)
    if (!event.defaultPrevented) {
      if (close()) app.emit("will-quit")
    }
  })
  let sequence = 0
  const guard = installShutdownGuard({
    app: Object.assign(app, { quit }) as unknown as App,
    ipcMain: ipc as IpcMain,
    createRequestId: () => `request-${++sequence}`,
    prepareQuit,
  })
  const electronWindow = Object.assign(window, {
    webContents,
    close,
    isDestroyed: () => false,
  }) as unknown as BrowserWindow
  const respond = (value: unknown, sender: unknown, senderFrame: unknown): void => {
    ipc.emit(SHUTDOWN_RESPONSE_CHANNEL, { sender, senderFrame }, value)
  }
  return {
    app,
    ipc,
    window,
    electronWindow,
    webContents,
    mainFrame,
    unload,
    close,
    quit,
    guard,
    respond,
  }
}

describe("shutdown guard through mocked Electron events", () => {
  test("agent shutdown waits for renderer approval and can cancel quitting", async () => {
    const prepare = vi.fn(async () => false)
    const h = harness(prepare)
    h.guard.attachWindow(h.electronWindow)
    h.quit()
    expect(prepare).not.toHaveBeenCalled()
    h.respond({ requestId: "request-1", allow: true }, h.webContents, h.mainFrame)
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
    expect(h.window.listenerCount("close")).toBe(1)
    prepare.mockResolvedValue(true)
    h.quit()
    h.respond({ requestId: "request-2", allow: true }, h.webContents, h.mainFrame)
    await vi.waitFor(() => expect(h.window.listenerCount("close")).toBe(0))
  })

  test("quit without a window still waits for agent shutdown", async () => {
    let resolve!: (allow: boolean) => void
    const prepare = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done
        }),
    )
    const h = harness(prepare)
    h.quit()
    expect(prepare).toHaveBeenCalledOnce()
    expect(h.quit).toHaveBeenCalledTimes(1)
    resolve(true)
    await vi.waitFor(() => expect(h.quit).toHaveBeenCalledTimes(2))
  })
  test("Restart to Update installs only after the current renderer approves quitting", () => {
    const h = harness()
    h.guard.attachWindow(h.electronWindow)
    const install = vi.fn()
    h.guard.requestUpdateInstall(install)
    expect(h.webContents.send).toHaveBeenCalledWith(SHUTDOWN_REQUEST_CHANNEL, {
      requestId: "request-1",
      intent: "quit",
    })
    expect(install).not.toHaveBeenCalled()
    h.respond({ requestId: "request-1", allow: true }, {}, h.mainFrame)
    h.respond({ requestId: "old", allow: true }, h.webContents, h.mainFrame)
    expect(install).not.toHaveBeenCalled()
    h.respond({ requestId: "request-1", allow: true }, h.webContents, h.mainFrame)
    expect(install).toHaveBeenCalledOnce()
    expect(h.quit).not.toHaveBeenCalled()
  })

  test("cancelled Restart to Update cannot install on a later ordinary quit", () => {
    const h = harness()
    h.guard.attachWindow(h.electronWindow)
    const install = vi.fn()
    h.guard.requestUpdateInstall(install)
    h.respond({ requestId: "request-1", allow: false }, h.webContents, h.mainFrame)
    h.quit()
    h.respond({ requestId: "request-2", allow: true }, h.webContents, h.mainFrame)
    expect(install).not.toHaveBeenCalled()
  })

  test("Restart to Update with no window invokes install without a renderer response", () => {
    const h = harness()
    const install = vi.fn()
    h.guard.requestUpdateInstall(install)
    expect(install).toHaveBeenCalledOnce()
    expect(h.webContents.send).not.toHaveBeenCalled()
  })

  test("Restart to Update supersedes pending close and permits its own quit once", () => {
    const h = harness()
    h.guard.attachWindow(h.electronWindow)
    h.close()
    const install = vi.fn(() => h.quit())
    h.guard.requestUpdateInstall(install)
    expect(h.webContents.send).toHaveBeenLastCalledWith(SHUTDOWN_REQUEST_CHANNEL, {
      requestId: "request-1",
      intent: "quit",
    })
    h.respond({ requestId: "request-1", allow: true }, h.webContents, h.mainFrame)
    expect(install).toHaveBeenCalledOnce()
    expect(h.webContents.send).toHaveBeenCalledTimes(2)
    expect(h.window.listenerCount("close")).toBe(0)
  })

  test("Restart to Update waits when a live window has lost its renderer", () => {
    const h = harness()
    h.guard.attachWindow(h.electronWindow)
    h.webContents.isDestroyed.mockReturnValue(true)
    const install = vi.fn()
    h.guard.requestUpdateInstall(install)
    expect(install).not.toHaveBeenCalled()
    expect(h.webContents.send).not.toHaveBeenCalled()
  })

  test("an approved update may quit asynchronously without a second renderer prompt", () => {
    const h = harness()
    h.guard.attachWindow(h.electronWindow)
    const install = vi.fn()
    h.guard.requestUpdateInstall(install)
    h.respond({ requestId: "request-1", allow: true }, h.webContents, h.mainFrame)
    expect(install).toHaveBeenCalledOnce()
    h.close()
    expect(h.window.listenerCount("close")).toBe(0)
    h.quit()
    expect(h.webContents.send).toHaveBeenCalledTimes(1)
  })

  test("a failed update clears asynchronous quit approval", () => {
    const h = harness()
    h.guard.attachWindow(h.electronWindow)
    h.guard.requestUpdateInstall(vi.fn())
    h.respond({ requestId: "request-1", allow: true }, h.webContents, h.mainFrame)
    h.guard.cancelUpdateInstall()
    h.quit()
    expect(h.webContents.send).toHaveBeenLastCalledWith(SHUTDOWN_REQUEST_CHANNEL, {
      requestId: "request-2",
      intent: "quit",
    })
  })

  test("a synchronously failed installer does not leave Quit approved", () => {
    const h = harness()
    h.guard.attachWindow(h.electronWindow)
    h.guard.requestUpdateInstall(() => {
      throw new Error("install failed")
    })
    expect(() =>
      h.respond({ requestId: "request-1", allow: true }, h.webContents, h.mainFrame),
    ).toThrow("install failed")
    h.quit()
    expect(h.webContents.send).toHaveBeenLastCalledWith(SHUTDOWN_REQUEST_CHANNEL, {
      requestId: "request-2",
      intent: "quit",
    })
  })

  test("ordinary approved full Quit installs a ready update and a canceled Quit does not", () => {
    const h = harness()
    h.guard.attachWindow(h.electronWindow)
    const install = vi.fn()
    h.guard.setInstallOnApprovedQuit(install)
    h.quit()
    h.respond({ requestId: "request-1", allow: false }, h.webContents, h.mainFrame)
    expect(install).not.toHaveBeenCalled()
    h.quit()
    h.respond({ requestId: "request-2", allow: true }, h.webContents, h.mainFrame)
    expect(install).toHaveBeenCalledOnce()
  })

  test("tray Quit installs a ready update without a window and can be disarmed", () => {
    const h = harness()
    const install = vi.fn()
    h.guard.setInstallOnApprovedQuit(install)
    h.quit()
    expect(install).toHaveBeenCalledOnce()
    h.guard.cancelUpdateInstall()
    h.guard.setInstallOnApprovedQuit(null)
    h.quit()
    expect(install).toHaveBeenCalledOnce()
  })

  test("disarming an update does not cancel an ordinary pending Quit", () => {
    const h = harness()
    h.guard.attachWindow(h.electronWindow)
    h.guard.setInstallOnApprovedQuit(vi.fn())
    h.quit()
    h.guard.setInstallOnApprovedQuit(null)
    h.guard.cancelUpdateInstall()
    const willQuit = vi.fn()
    h.app.on("will-quit", willQuit)
    h.respond({ requestId: "request-1", allow: true }, h.webContents, h.mainFrame)
    expect(willQuit).toHaveBeenCalledOnce()
  })

  test("close and quit stay open until the current main-frame response allows them", () => {
    const h = harness()
    h.guard.attachWindow(h.electronWindow)
    const closed = vi.fn()
    h.window.on("closed", closed)
    h.close()
    h.close()
    expect(closed).not.toHaveBeenCalled()
    expect(h.webContents.send).toHaveBeenCalledTimes(2)
    expect(h.webContents.send).toHaveBeenLastCalledWith(SHUTDOWN_REQUEST_CHANNEL, {
      requestId: "request-1",
      intent: "close",
    })
    h.respond({ requestId: "request-1", allow: true }, h.webContents, h.mainFrame)
    expect(closed).toHaveBeenCalledOnce()
    expect(h.quit).not.toHaveBeenCalled()
  })

  test("canceled quit never reaches will-quit and a later attempt needs a new approval", () => {
    const h = harness()
    h.guard.attachWindow(h.electronWindow)
    const disposeServices = vi.fn()
    h.app.on("will-quit", disposeServices)
    h.quit()
    h.respond({ requestId: "request-1", allow: false }, h.webContents, h.mainFrame)
    expect(disposeServices).not.toHaveBeenCalled()
    h.quit()
    h.respond({ requestId: "request-1", allow: true }, h.webContents, h.mainFrame)
    expect(disposeServices).not.toHaveBeenCalled()
    h.respond({ requestId: "request-2", allow: true }, h.webContents, h.mainFrame)
    expect(disposeServices).toHaveBeenCalledOnce()
    expect(h.webContents.send).toHaveBeenCalledTimes(2)
  })

  test("quit supersedes close on the same request and associated close does not prompt again", () => {
    const h = harness()
    h.guard.attachWindow(h.electronWindow)
    h.close()
    h.quit()
    h.quit()
    h.close()
    expect(h.webContents.send.mock.calls).toEqual([
      [SHUTDOWN_REQUEST_CHANNEL, { requestId: "request-1", intent: "close" }],
      [SHUTDOWN_REQUEST_CHANNEL, { requestId: "request-1", intent: "quit" }],
      [SHUTDOWN_REQUEST_CHANNEL, { requestId: "request-1", intent: "quit" }],
      [SHUTDOWN_REQUEST_CHANNEL, { requestId: "request-1", intent: "quit" }],
    ])
    const willQuit = vi.fn()
    h.app.on("will-quit", willQuit)
    h.respond({ requestId: "request-1", allow: true }, h.webContents, h.mainFrame)
    expect(willQuit).toHaveBeenCalledOnce()
    expect(h.webContents.send).toHaveBeenCalledTimes(4)
  })

  test("malformed, stale, other-window, and child-frame responses cannot approve shutdown", () => {
    const h = harness()
    h.guard.attachWindow(h.electronWindow)
    h.quit()
    const willQuit = vi.fn()
    h.app.on("will-quit", willQuit)
    for (const response of [
      null,
      [],
      { requestId: "request-1", allow: "yes" },
      { requestId: "old", allow: true },
    ]) {
      h.respond(response, h.webContents, h.mainFrame)
    }
    h.respond({ requestId: "request-1", allow: true }, {}, h.mainFrame)
    h.respond({ requestId: "request-1", allow: true }, h.webContents, {})
    h.respond({ requestId: "request-1", allow: true }, h.webContents, null)
    expect(willQuit).not.toHaveBeenCalled()
    h.respond({ requestId: "request-1", allow: true }, h.webContents, h.mainFrame)
    expect(willQuit).toHaveBeenCalledOnce()
  })

  test("closed windows lose subscriptions and reopening uses only the new window", () => {
    const h = harness()
    h.guard.attachWindow(h.electronWindow)
    h.close()
    h.respond({ requestId: "request-1", allow: true }, h.webContents, h.mainFrame)
    expect(h.window.listenerCount("close")).toBe(0)
    expect(h.window.listenerCount("closed")).toBe(0)
    const reopened = harness()
    h.guard.attachWindow(reopened.electronWindow)
    reopened.close()
    h.respond({ requestId: "request-2", allow: true }, h.webContents, h.mainFrame)
    expect(reopened.window.listenerCount("close")).toBe(1)
    h.respond({ requestId: "request-2", allow: true }, reopened.webContents, reopened.mainFrame)
    expect(reopened.window.listenerCount("close")).toBe(0)
  })

  test("startup failure without a window can quit and disposal removes all guard subscriptions", () => {
    const h = harness()
    const willQuit = vi.fn()
    h.app.on("will-quit", willQuit)
    h.quit()
    expect(willQuit).toHaveBeenCalledOnce()
    h.guard.attachWindow(h.electronWindow)
    h.guard.dispose()
    expect(h.window.listenerCount("close")).toBe(0)
    expect(h.window.listenerCount("closed")).toBe(0)
    expect(h.app.listenerCount("before-quit")).toBe(0)
    expect(h.ipc.listenerCount(SHUTDOWN_RESPONSE_CHANNEL)).toBe(0)
  })

  test("another before-quit listener canceling approval requires a fresh request for quit and close", () => {
    const h = harness()
    h.guard.attachWindow(h.electronWindow)
    const cancel = (event: { preventDefault: () => void }): void => event.preventDefault()
    h.app.on("before-quit", cancel)
    h.quit()
    h.respond({ requestId: "request-1", allow: true }, h.webContents, h.mainFrame)
    h.app.removeListener("before-quit", cancel)
    h.close()
    expect(h.webContents.send).toHaveBeenLastCalledWith(SHUTDOWN_REQUEST_CHANNEL, {
      requestId: "request-2",
      intent: "close",
    })
    h.quit()
    expect(h.webContents.send).toHaveBeenLastCalledWith(SHUTDOWN_REQUEST_CHANNEL, {
      requestId: "request-2",
      intent: "quit",
    })
  })

  test("renderer beforeunload canceling approved quit does not approve a later quit", () => {
    const h = harness()
    h.guard.attachWindow(h.electronWindow)
    h.unload.blocked = true
    h.quit()
    h.respond({ requestId: "request-1", allow: true }, h.webContents, h.mainFrame)
    h.unload.blocked = false
    h.quit()
    expect(h.webContents.send).toHaveBeenLastCalledWith(SHUTDOWN_REQUEST_CHANNEL, {
      requestId: "request-2",
      intent: "quit",
    })
    h.respond({ requestId: "request-2", allow: true }, h.webContents, h.mainFrame)
    expect(h.window.listenerCount("close")).toBe(0)
  })

  test("destroyed renderer cannot throw while a shutdown attempt stays blocked", () => {
    const h = harness()
    h.guard.attachWindow(h.electronWindow)
    h.webContents.isDestroyed.mockReturnValue(true)
    h.webContents.send.mockImplementation(() => {
      throw new Error("destroyed renderer")
    })
    expect(() => h.quit()).not.toThrow()
    expect(h.webContents.send).not.toHaveBeenCalled()
    expect(h.window.listenerCount("close")).toBe(1)
  })
})
