import { beforeEach, expect, test, vi } from "vitest"
import { PublicUpdateController, type UpdateEngine } from "./controller"

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
beforeEach(() => vi.resetModules())

test("manual checks show unavailable builds and network errors instead of silently failing", async () => {
  const feedback = await import("./feedback")
  await feedback.checkForUpdates()
  expect(feedback.updateSnapshot().message).toContain("This build does not auto-update")
  const engine: UpdateEngine = {
    configure: vi.fn(),
    onDownloaded: vi.fn(),
    onUnavailable: vi.fn(),
    onError: vi.fn(),
    check: vi.fn(async () => {
      throw new Error("offline")
    }),
    install: vi.fn(),
  }
  const controller = new PublicUpdateController(
    engine,
    { formatVersion: 1, migrations: [] },
    feedback.publishUpdateStatus,
    vi.fn(),
    vi.fn(),
  )
  feedback.connectUpdateFeedback(controller)
  await controller.start("stable")
  await feedback.checkForUpdates()
  expect(feedback.updateSnapshot()).toMatchObject({
    checking: false,
    message: "Could not check for updates: offline",
  })
})

test("automatic checks stay quiet and ready updates always show restart feedback", async () => {
  const feedback = await import("./feedback")
  feedback.publishUpdateStatus({ kind: "checking" })
  feedback.publishUpdateStatus({ kind: "idle" })
  expect(feedback.updateSnapshot().message).toBeNull()
  feedback.publishUpdateStatus({ kind: "ready", version: "1.2.0" })
  expect(feedback.updateSnapshot().message).toBe("PI Lab 1.2.0 is ready to install on restart.")
})

test("recreated windows do not replay expired update notices", async () => {
  vi.useFakeTimers()
  const feedback = await import("./feedback")
  feedback.publishUpdateStatus({ kind: "ready", version: "1.2.0" })
  expect(feedback.updateSnapshot().message).not.toBeNull()
  vi.advanceTimersByTime(3000)
  expect(feedback.updateSnapshot().message).toBeNull()
  vi.useRealTimers()
})

test("manual checks reuse an in-progress check and report no update or a ready download", async () => {
  const feedback = await import("./feedback")
  let unavailable: () => void = () => {}
  let downloaded: (candidate: { version: string; compatibility: unknown }) => void = () => {}
  const compatibility = { formatVersion: 1, migrations: [] }
  const engine: UpdateEngine = {
    configure: vi.fn(),
    onDownloaded: (listener) => {
      downloaded = listener
    },
    onUnavailable: (listener) => {
      unavailable = listener
    },
    onError: vi.fn(),
    check: vi.fn(async () => {}),
    install: vi.fn(),
  }
  const controller = new PublicUpdateController(
    engine,
    compatibility,
    feedback.publishUpdateStatus,
    vi.fn(),
    vi.fn(),
  )
  feedback.connectUpdateFeedback(controller)
  await controller.start("stable")
  await feedback.checkForUpdates()
  expect(engine.check).toHaveBeenCalledOnce()
  expect(feedback.updateSnapshot().message).toBe("Checking for updates…")
  unavailable()
  expect(feedback.updateSnapshot().message).toBe("PI Lab is up to date.")
  downloaded({ version: "1.2.0", compatibility })
  await feedback.checkForUpdates()
  expect(engine.check).toHaveBeenCalledOnce()
  expect(feedback.updateSnapshot().message).toContain("ready to install on restart")
})
