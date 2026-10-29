import { expect, test, vi } from "vitest"
import {
  confirmStopDialog,
  createUserQuitAction,
  type QuitWork,
  runningWorkDialog,
} from "./userQuit"

const idle: QuitWork = { agents: 0, terminals: [] }
const agents = (count: number): QuitWork => ({ agents: count, terminals: [] })

test("each explicit quit offers all choices, background and cancel leave work running", async () => {
  const choose = vi
    .fn()
    .mockResolvedValueOnce("cancel")
    .mockResolvedValueOnce("background")
    .mockResolvedValueOnce("quit")
  const quit = vi.fn()
  const background = vi.fn()
  const request = createUserQuitAction({
    pending: () => false,
    work: async () => agents(2),
    choose,
    confirmRunning: async () => "quit",
    quit,
    background,
    error: vi.fn(),
  })
  await request()
  expect(quit).not.toHaveBeenCalled()
  await request()
  expect(background).toHaveBeenCalledOnce()
  expect(quit).not.toHaveBeenCalled()
  await request()
  expect(quit).toHaveBeenCalledOnce()
  expect(choose).toHaveBeenCalledTimes(3)
  expect(choose).toHaveBeenCalledWith(agents(2))
})

test("concurrent Cmd+Q does not open duplicate dialogs", async () => {
  let finish!: (value: "cancel") => void
  const choose = vi.fn(
    () =>
      new Promise<"cancel">((resolve) => {
        finish = resolve
      }),
  )
  const request = createUserQuitAction({
    pending: () => false,
    work: async () => idle,
    choose,
    confirmRunning: async () => "quit",
    quit: vi.fn(),
    background: vi.fn(),
    error: vi.fn(),
  })
  const first = request()
  await vi.waitFor(() => expect(choose).toHaveBeenCalledOnce())
  await request()
  expect(choose).toHaveBeenCalledOnce()
  finish("cancel")
  await first
})

test("choosing Quit rechecks running work and offers a separate background or cancel choice", async () => {
  const quit = vi.fn()
  const background = vi.fn()
  const work = vi.fn().mockResolvedValue(agents(2))
  const confirmRunning = vi
    .fn()
    .mockResolvedValueOnce("background")
    .mockResolvedValueOnce("cancel")
    .mockResolvedValueOnce("quit")
  const request = createUserQuitAction({
    pending: () => false,
    work,
    choose: async () => "quit",
    confirmRunning,
    quit,
    background,
    error: vi.fn(),
  })
  await request()
  expect(confirmRunning).toHaveBeenCalledWith(agents(2))
  expect(background).toHaveBeenCalledOnce()
  expect(quit).not.toHaveBeenCalled()
  await request()
  expect(quit).not.toHaveBeenCalled()
  await request()
  expect(quit).toHaveBeenCalledOnce()
})

test("no running work requires only the initial choice", async () => {
  const confirmRunning = vi.fn()
  const quit = vi.fn()
  const request = createUserQuitAction({
    pending: () => false,
    work: async () => idle,
    choose: async () => "quit",
    confirmRunning,
    quit,
    background: vi.fn(),
    error: vi.fn(),
  })
  await request()
  expect(confirmRunning).not.toHaveBeenCalled()
  expect(quit).toHaveBeenCalledOnce()
})

test("Quit label uses the initial count but newly started work still gets its second confirmation", async () => {
  const choose = vi.fn(async () => "quit" as const)
  const confirmRunning = vi.fn(async () => "cancel" as const)
  const quit = vi.fn()
  const request = createUserQuitAction({
    pending: () => false,
    work: vi.fn().mockResolvedValueOnce(idle).mockResolvedValueOnce(agents(1)),
    choose,
    confirmRunning,
    quit,
    background: vi.fn(),
    error: vi.fn(),
  })
  await request()
  expect(choose).toHaveBeenCalledWith(idle)
  expect(confirmRunning).toHaveBeenCalledWith(agents(1))
  expect(quit).not.toHaveBeenCalled()
})

test("a busy terminal alone gets the running-work confirmation; idle shells do not", async () => {
  const busy: QuitWork = { agents: 0, terminals: [{ project: "Alpha", command: "sleep" }] }
  const confirmRunning = vi.fn(async () => "cancel" as const)
  const quit = vi.fn()
  const request = createUserQuitAction({
    pending: () => false,
    work: async () => busy,
    choose: async () => "quit",
    confirmRunning,
    quit,
    background: vi.fn(),
    error: vi.fn(),
  })
  await request()
  expect(confirmRunning).toHaveBeenCalledWith(busy)
  expect(quit).not.toHaveBeenCalled()
})

test("the running-work dialog names busy terminals and keeps the agent wording", () => {
  const terminals = [
    { project: "Alpha", command: "sleep" },
    { project: "Beta", command: "python" },
  ]
  const onlyTerminals = runningWorkDialog({ agents: 0, terminals })
  expect(onlyTerminals.message).toBe("2 terminals are still running a command.")
  expect(onlyTerminals.detail).toContain("Alpha: sleep")
  expect(onlyTerminals.detail).toContain("Beta: python")
  expect(onlyTerminals.buttons).toEqual([
    "Quit and stop terminals",
    "Keep running in background",
    "Cancel",
  ])
  const withAgent = runningWorkDialog({ agents: 1, terminals: terminals.slice(0, 1) })
  expect(withAgent.message).toBe("1 agent is still running.")
  expect(withAgent.detail).toContain("Agents or results fetching are currently running.")
  expect(withAgent.detail).toContain("Alpha: sleep")
  expect(withAgent.buttons).toEqual([
    "Quit and stop agents",
    "Keep agents running in background",
    "Cancel",
  ])
  expect(runningWorkDialog(agents(2)).detail).toBe(
    "Agents or results fetching are currently running. Quit and stop agents ends that work. Keep agents running in background leaves PI Lab and the work running.",
  )
})

test("a logout or other quit asks with the same wording but only Quit and stop or Cancel", () => {
  const terminals = [{ project: "Alpha", command: "sleep" }]
  const onlyTerminals = confirmStopDialog({ agents: 0, terminals })
  expect(onlyTerminals.message).toBe("1 terminal is still running a command.")
  expect(onlyTerminals.detail).toContain("Alpha: sleep")
  expect(onlyTerminals.buttons).toEqual(["Quit and stop terminals", "Cancel"])
  const withAgents = confirmStopDialog({ agents: 2, terminals })
  expect(withAgents.message).toBe("2 agents are still running.")
  expect(withAgents.detail).toContain("Agents or results fetching are currently running.")
  expect(withAgents.detail).not.toContain("background")
  expect(withAgents.detail).toContain("Alpha: sleep")
  expect(withAgents.buttons).toEqual(["Quit and stop agents", "Cancel"])
})
