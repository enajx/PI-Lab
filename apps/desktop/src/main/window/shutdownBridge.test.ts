import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  SHUTDOWN_REQUEST_CHANNEL,
  SHUTDOWN_RESPONSE_CHANNEL,
  type ShutdownBridge,
} from "../../shared/shutdown"

const electron = vi.hoisted(() => ({
  expose: vi.fn(),
  exposeTRPC: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
}))

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: {
    on: electron.on,
    removeListener: electron.removeListener,
    send: electron.send,
  },
}))
vi.mock("trpc-electron/main", () => ({ exposeElectronTRPC: electron.exposeTRPC }))

/** Import the real preload with mocked Electron; native isolation is covered by E2E. */
async function loadPreload(mainFrame: boolean): Promise<void> {
  vi.stubGlobal(
    "process",
    new Proxy(process, {
      get: (target, property) =>
        property === "isMainFrame" ? mainFrame : Reflect.get(target, property),
    }),
  )
  await import("../../preload/index")
}

describe("shutdown preload bridge with mocked Electron", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })
  afterEach(() => vi.unstubAllGlobals())

  test("subscriptions validate requests, hide Electron events, and remove their exact listener", async () => {
    await loadPreload(true)
    const exposed = electron.expose.mock.calls[0]?.[1] as { shutdown: ShutdownBridge }
    expect(exposed.shutdown).toBeDefined()
    const listener = vi.fn()
    const unsubscribe = exposed.shutdown.subscribe(listener)
    expect(electron.on.mock.calls[0]?.[0]).toBe(SHUTDOWN_REQUEST_CHANNEL)
    const receive = electron.on.mock.calls[0]?.[1] as (event: unknown, value: unknown) => void
    receive({ secret: "Electron event" }, { requestId: "one", intent: "quit", extra: "hidden" })
    receive({}, { requestId: "one", intent: "other" })
    receive({}, null)
    expect(listener).toHaveBeenCalledExactlyOnceWith({ requestId: "one", intent: "quit" })
    unsubscribe()
    expect(electron.removeListener).toHaveBeenCalledExactlyOnceWith(
      SHUTDOWN_REQUEST_CHANNEL,
      receive,
    )
  })

  test("responses use only the typed response channel and payload", async () => {
    await loadPreload(true)
    const exposed = electron.expose.mock.calls[0]?.[1] as { shutdown: ShutdownBridge }
    exposed.shutdown.respond({ requestId: "one", allow: true })
    exposed.shutdown.respond({ requestId: "one", allow: "invalid" } as unknown as Parameters<
      ShutdownBridge["respond"]
    >[0])
    expect(electron.send).toHaveBeenCalledExactlyOnceWith(SHUTDOWN_RESPONSE_CHANNEL, {
      requestId: "one",
      allow: true,
    })
  })

  test("child frames receive no preload bridge", async () => {
    await loadPreload(false)
    expect(electron.expose).not.toHaveBeenCalled()
    expect(electron.exposeTRPC).not.toHaveBeenCalled()
  })
})
