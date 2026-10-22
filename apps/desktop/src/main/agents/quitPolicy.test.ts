import { expect, test, vi } from "vitest"
import { prepareAgentQuit } from "./quitPolicy"

test("cancel and Settings preserve all agents; confirmed quit awaits their stop", async () => {
  const stop = vi.fn(async () => {})
  const resume = vi.fn()
  const settings = vi.fn()
  const base = {
    pause: async () => {},
    resume,
    behavior: () => "stop" as const,
    count: async () => 2,
    stop,
    settings,
  }
  expect(await prepareAgentQuit({ ...base, confirm: async () => "cancel" })).toBe(false)
  expect(await prepareAgentQuit({ ...base, confirm: async () => "settings" })).toBe(false)
  expect(settings).toHaveBeenCalledOnce()
  expect(stop).not.toHaveBeenCalled()
  expect(resume).toHaveBeenCalledTimes(2)
  let resolve!: () => void
  stop.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done
      }),
  )
  let finished = false
  const quitting = prepareAgentQuit({ ...base, confirm: async () => "stop" }).then((allow) => {
    finished = allow
  })
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
  expect(finished).toBe(false)
  resolve()
  await quitting
  expect(finished).toBe(true)
})

test("keep-running leaves agents alive; failed stop cancels quit and resumes launches", async () => {
  const confirm = vi.fn(async () => "stop" as const)
  const stop = vi.fn(async () => {
    throw new Error("unable to stop")
  })
  const resume = vi.fn()
  const base = {
    pause: async () => {},
    resume,
    count: async () => 1,
    stop,
    settings: () => {},
    confirm,
  }
  expect(await prepareAgentQuit({ ...base, behavior: () => "keep-running" })).toBe(true)
  expect(confirm).not.toHaveBeenCalled()
  expect(stop).not.toHaveBeenCalled()
  await expect(prepareAgentQuit({ ...base, behavior: () => "stop" })).rejects.toThrow(
    "unable to stop",
  )
  expect(resume).toHaveBeenCalledOnce()
})
