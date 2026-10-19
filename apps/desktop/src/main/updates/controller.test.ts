import { describe, expect, test, vi } from "vitest"
import type { DataCompatibility } from "./compatibility"
import { PublicUpdateController, type UpdateEngine } from "./controller"

const compatibility: DataCompatibility = {
  formatVersion: 1,
  migrations: [{ hash: "first", createdAt: 1 }],
}

/** Drive update events through the same methods used by the Electron adapter. */
function harness() {
  let downloaded: ((candidate: { version: string; compatibility: unknown }) => void) | null = null
  let unavailable: (() => void) | null = null
  let failed: ((error: Error) => void) | null = null
  const engine: UpdateEngine = {
    configure: vi.fn(),
    onDownloaded: (listener) => {
      downloaded = listener
    },
    onUnavailable: (listener) => {
      unavailable = listener
    },
    onError: (listener) => {
      failed = listener
    },
    check: vi.fn(async () => {}),
    install: vi.fn(),
  }
  const status = vi.fn()
  const approveQuit = vi.fn((install: () => void) => install())
  const installOnApprovedQuit = vi.fn()
  const controller = new PublicUpdateController(
    engine,
    compatibility,
    status,
    approveQuit,
    installOnApprovedQuit,
  )
  return {
    engine,
    status,
    approveQuit,
    installOnApprovedQuit,
    controller,
    downloaded: (version: string, candidateCompatibility: unknown = compatibility) =>
      downloaded?.({ version, compatibility: candidateCompatibility }),
    unavailable: () => unavailable?.(),
    failed: (error: Error) => failed?.(error),
  }
}

describe("public update controller", () => {
  test("checks the selected feed after start and keeps downloaded updates for full Quit", async () => {
    const h = harness()
    await h.controller.start("beta")
    expect(h.engine.configure).toHaveBeenCalledWith("beta")
    expect(h.engine.check).toHaveBeenCalledOnce()
    h.downloaded("1.2.0-beta.2")
    expect(h.controller.current()).toEqual({ kind: "ready", version: "1.2.0-beta.2" })
    expect(h.status).toHaveBeenLastCalledWith({ kind: "ready", version: "1.2.0-beta.2" })
    const ordinaryQuitInstall = h.installOnApprovedQuit.mock.lastCall?.[0]
    ordinaryQuitInstall?.()
    expect(h.engine.install).toHaveBeenCalledWith(false)
    h.controller.restartToUpdate()
    expect(h.approveQuit).toHaveBeenCalledOnce()
    expect(h.engine.install).toHaveBeenCalledWith(true)
  })

  test("changing the selected channel disarms a previously downloaded update", async () => {
    const h = harness()
    await h.controller.start("beta")
    h.downloaded("1.3.0-beta.20")
    h.controller.selectedChannelChanged("stable")
    expect(h.installOnApprovedQuit).toHaveBeenLastCalledWith(null)
    expect(h.controller.current()).toEqual({ kind: "restart-required" })
    h.controller.restartToUpdate()
    expect(h.approveQuit).not.toHaveBeenCalled()
    expect(h.engine.install).not.toHaveBeenCalled()
  })

  test("reports checks and failures without throwing away the app", async () => {
    const h = harness()
    await h.controller.start("stable")
    h.unavailable()
    expect(h.controller.current()).toEqual({ kind: "idle" })
    h.failed(new Error("offline"))
    expect(h.controller.current()).toEqual({ kind: "error", message: "offline" })
  })

  test("a failed network check reports an error and leaves normal quit intact", async () => {
    const h = harness()
    vi.mocked(h.engine.check).mockRejectedValueOnce(new Error("feed unavailable"))
    await h.controller.start("stable")
    expect(h.controller.current()).toEqual({ kind: "error", message: "feed unavailable" })
    expect(h.installOnApprovedQuit).toHaveBeenLastCalledWith(null)
  })

  test("checks again while idle, but leaves a ready download untouched", async () => {
    const h = harness()
    await h.controller.start("stable")
    h.unavailable()
    await h.controller.checkAgain()
    expect(h.engine.check).toHaveBeenCalledTimes(2)
    h.downloaded("1.2.0")
    await h.controller.checkAgain()
    expect(h.engine.check).toHaveBeenCalledTimes(2)
  })

  test("never arms an incompatible Stable download and accepts a later compatible release", async () => {
    const h = harness()
    await h.controller.start("stable")
    h.downloaded("1.2.0", { formatVersion: 1, migrations: [] })
    expect(h.controller.current()).toMatchObject({ kind: "waiting-for-compatible-release" })
    expect(h.installOnApprovedQuit).toHaveBeenLastCalledWith(null)
    h.controller.restartToUpdate()
    expect(h.engine.install).not.toHaveBeenCalled()
    await h.controller.checkAgain()
    expect(h.engine.check).toHaveBeenCalledTimes(2)
    h.downloaded("1.3.0")
    expect(h.controller.current()).toEqual({ kind: "ready", version: "1.3.0" })
  })
})
