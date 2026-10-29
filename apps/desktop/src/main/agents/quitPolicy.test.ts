import { expect, test, vi } from "vitest"
import type { QuitWork } from "../window/userQuit"
import { prepareAgentQuit, type QuitMode } from "./quitPolicy"

const idle: QuitWork = { agents: 0, terminals: [] }
const busy: QuitWork = { agents: 0, terminals: [{ project: "Alpha", command: "sleep" }] }

function dependencies(mode: QuitMode, work: QuitWork, choice: "stop" | "cancel") {
  return {
    mode,
    pause: vi.fn(async () => {}),
    resume: vi.fn(),
    work: vi.fn(async () => work),
    confirm: vi.fn(async () => choice),
    stop: vi.fn(async () => {}),
  }
}

test("explicit Quit ends everything without asking again", async () => {
  const deps = dependencies("end", busy, "cancel")
  expect(await prepareAgentQuit(deps)).toBe(true)
  expect(deps.confirm).not.toHaveBeenCalled()
  expect(deps.stop).toHaveBeenCalledOnce()
})

test("Restart to Update keeps agents, shells and Python runs running", async () => {
  const deps = dependencies("keep", busy, "stop")
  expect(await prepareAgentQuit(deps)).toBe(true)
  expect(deps.work).not.toHaveBeenCalled()
  expect(deps.confirm).not.toHaveBeenCalled()
  expect(deps.stop).not.toHaveBeenCalled()
})

test("a system or other quit asks only when work is running, then ends everything", async () => {
  const quiet = dependencies("confirm-end", idle, "cancel")
  expect(await prepareAgentQuit(quiet)).toBe(true)
  expect(quiet.confirm).not.toHaveBeenCalled()
  expect(quiet.stop).toHaveBeenCalledOnce()

  const cancelled = dependencies("confirm-end", busy, "cancel")
  expect(await prepareAgentQuit(cancelled)).toBe(false)
  expect(cancelled.confirm).toHaveBeenCalledWith(busy)
  expect(cancelled.stop).not.toHaveBeenCalled()
  expect(cancelled.resume).toHaveBeenCalledOnce()

  const confirmed = dependencies("confirm-end", { agents: 2, terminals: [] }, "stop")
  expect(await prepareAgentQuit(confirmed)).toBe(true)
  expect(confirmed.stop).toHaveBeenCalledOnce()
})

test("quit waits for the stop and a failed stop cancels quit and resumes launches", async () => {
  const deps = dependencies("end", idle, "stop")
  let resolve!: () => void
  deps.stop.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done
      }),
  )
  let finished = false
  const quitting = prepareAgentQuit(deps).then((allow) => {
    finished = allow
  })
  await vi.waitFor(() => expect(deps.stop).toHaveBeenCalledOnce())
  expect(finished).toBe(false)
  resolve()
  await quitting
  expect(finished).toBe(true)

  const failing = dependencies("end", idle, "stop")
  failing.stop.mockRejectedValue(new Error("unable to stop"))
  await expect(prepareAgentQuit(failing)).rejects.toThrow("unable to stop")
  expect(failing.resume).toHaveBeenCalledOnce()
})
