import { afterEach, expect, test, vi } from "vitest"
import { createHarness, type Harness } from "../testHarness"

const mocks = vi.hoisted(() => ({ install: vi.fn(), probe: vi.fn() }))
vi.mock("../../latex/install", () => ({
  defaultPdfLatexInstallDir: (home: string) => `${home}/TinyTeX`,
  installPdfLatex: mocks.install,
}))
vi.mock("../../latex/runtime", () => ({ probeLatexRuntimes: mocks.probe }))
let h: Harness | undefined
afterEach(async () => {
  await h?.dispose()
  vi.clearAllMocks()
})

/** Mocked installer boundary: public router retains failures and only selects a validated install. */
test("install is explicit, reports failure, and switches globally only after success", async () => {
  mocks.probe.mockResolvedValue({ bundled: { available: true }, system: { available: false } })
  h = await createHarness([], { git: false, daemon: "lazy" })
  const caller = h.caller
  expect((await h.caller.latex.status()).provider).toBe("bundled")
  expect(mocks.install).not.toHaveBeenCalled()
  mocks.install.mockRejectedValueOnce(new Error("download failed"))
  await h.caller.latex.install()
  await vi.waitFor(async () =>
    expect((await caller.latex.status()).installation.state).toBe("failed"),
  )
  expect((await h.caller.latex.status()).provider).toBe("bundled")
  mocks.install.mockResolvedValueOnce({ binDir: "/tmp/validated/bin" })
  await h.caller.latex.install()
  await vi.waitFor(async () =>
    expect((await caller.latex.status()).installation.state).toBe("complete"),
  )
  expect((await h.caller.settings.get()).editor.latexProvider).toBe("system")
})

/** Mocked download: stage updates remain observable and repeated clicks cannot start two installs. */
test("reports typed install stages and rejects duplicate starts", async () => {
  mocks.probe.mockResolvedValue({ bundled: { available: true }, system: { available: false } })
  h = await createHarness([], { git: false, daemon: "lazy" })
  const caller = h.caller
  let finish: () => void = () => {
    throw new Error("Installer has not started")
  }
  mocks.install.mockImplementation(({ onProgress }: { onProgress: (stage: string) => void }) => {
    onProgress("extracting")
    return new Promise<void>((resolve) => {
      finish = resolve
    })
  })
  expect(await caller.latex.install()).toEqual({ started: true })
  await vi.waitFor(async () => {
    expect((await caller.latex.status()).installation).toMatchObject({
      state: "extracting",
      progress: 50,
    })
  })
  expect(await caller.latex.install()).toEqual({ started: false })
  expect(mocks.install).toHaveBeenCalledTimes(1)
  finish()
  await vi.waitFor(async () =>
    expect((await caller.latex.status()).installation.state).toBe("complete"),
  )
})

/** Mocked probe: an existing usable system installation is selected without another download. */
test("preserves an existing system installation", async () => {
  mocks.probe.mockResolvedValue({ bundled: { available: true }, system: { available: true } })
  h = await createHarness([], { git: false, daemon: "lazy" })
  await h.caller.latex.install()
  expect(mocks.install).not.toHaveBeenCalled()
  expect((await h.caller.settings.get()).editor.latexProvider).toBe("system")
})

/** Mocked slow probe: completion cannot leave the settings chooser showing the old provider. */
test("reads the current provider after a slow status probe finishes", async () => {
  const tools = { bundled: { available: true }, system: { available: true } }
  mocks.probe.mockResolvedValue(tools)
  h = await createHarness([], { git: false, daemon: "lazy" })
  const caller = h.caller
  let finish: () => void = () => {
    throw new Error("Probe has not started")
  }
  mocks.probe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(tools)
      }),
  )
  const pendingStatus = caller.latex.status()
  await vi.waitFor(() => expect(mocks.probe).toHaveBeenCalledTimes(1))
  await caller.latex.install()
  await vi.waitFor(async () =>
    expect((await caller.settings.get()).editor.latexProvider).toBe("system"),
  )
  finish()
  expect(await pendingStatus).toMatchObject({
    provider: "system",
    installation: { state: "complete" },
  })
})
