import { expect, test, vi } from "vitest"
import {
  confirmStopDialog,
  createUserQuitAction,
  type QuitWork,
  runningWorkDialog,
} from "./userQuit"

const idle: QuitWork = { agents: 0, terminals: [], notebooks: 0 }
const agents = (count: number): QuitWork => ({ agents: count, terminals: [], notebooks: 0 })
/** A first-dialog answer without "Remember Move to background" ticked. */
const pick = <C extends "quit" | "background" | "cancel">(choice: C) => ({
  choice,
  remember: false,
})

/** Quit action with a remembered choice; every other dependency is a spy. */
function rememberHarness(
  remembered: "ask" | "background",
  answer: { choice: "quit" | "background" | "cancel"; remember: boolean },
  running: "quit" | "background" | "cancel",
  work: QuitWork,
) {
  const spies = {
    choose: vi.fn(async () => answer),
    confirmRunning: vi.fn(async () => running),
    remember: vi.fn(),
    quit: vi.fn(),
    background: vi.fn(),
  }
  const request = createUserQuitAction({
    pending: () => false,
    remembered: () => remembered,
    work: async () => work,
    error: vi.fn(),
    ...spies,
  })
  return { request, ...spies }
}

test("a remembered Move to background skips the dialog and moves to the background", async () => {
  const h = rememberHarness("background", pick("cancel"), "cancel", agents(1))
  await h.request()
  expect(h.choose).not.toHaveBeenCalled()
  expect(h.confirmRunning).not.toHaveBeenCalled()
  expect(h.background).toHaveBeenCalledOnce()
  expect(h.quit).not.toHaveBeenCalled()
})

test("ticking Remember Move to background with Move to background saves it", async () => {
  const h = rememberHarness("ask", { choice: "background", remember: true }, "cancel", agents(1))
  await h.request()
  expect(h.remember).toHaveBeenCalledExactlyOnceWith("background")
  expect(h.background).toHaveBeenCalledOnce()
})

test("Quit with the box ticked quits but saves nothing", async () => {
  const running = rememberHarness("ask", { choice: "quit", remember: true }, "quit", agents(1))
  await running.request()
  expect(running.quit).toHaveBeenCalledOnce()
  expect(running.remember).not.toHaveBeenCalled()
  const idleQuit = rememberHarness("ask", { choice: "quit", remember: true }, "quit", idle)
  await idleQuit.request()
  expect(idleQuit.quit).toHaveBeenCalledOnce()
  expect(idleQuit.remember).not.toHaveBeenCalled()
})

test("Cancel never saves, in the first dialog or the running-work dialog", async () => {
  const first = rememberHarness("ask", { choice: "cancel", remember: true }, "quit", idle)
  await first.request()
  expect(first.remember).not.toHaveBeenCalled()
  const second = rememberHarness("ask", { choice: "quit", remember: true }, "cancel", agents(1))
  await second.request()
  expect(second.remember).not.toHaveBeenCalled()
  expect(second.quit).not.toHaveBeenCalled()
})

test("an unticked choice is not saved", async () => {
  const h = rememberHarness("ask", pick("background"), "cancel", idle)
  await h.request()
  expect(h.remember).not.toHaveBeenCalled()
})

test("each explicit quit offers all choices, background and cancel leave work running", async () => {
  const choose = vi
    .fn()
    .mockResolvedValueOnce(pick("cancel"))
    .mockResolvedValueOnce(pick("background"))
    .mockResolvedValueOnce(pick("quit"))
  const quit = vi.fn()
  const background = vi.fn()
  const request = createUserQuitAction({
    pending: () => false,
    remembered: () => "ask",
    remember: vi.fn(),
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
  let finish!: (value: { choice: "cancel"; remember: boolean }) => void
  const choose = vi.fn(
    () =>
      new Promise<{ choice: "cancel"; remember: boolean }>((resolve) => {
        finish = resolve
      }),
  )
  const request = createUserQuitAction({
    pending: () => false,
    remembered: () => "ask",
    remember: vi.fn(),
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
  finish(pick("cancel"))
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
    remembered: () => "ask",
    remember: vi.fn(),
    work,
    choose: async () => pick("quit"),
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
    remembered: () => "ask",
    remember: vi.fn(),
    work: async () => idle,
    choose: async () => pick("quit"),
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
  const choose = vi.fn(async () => pick("quit"))
  const confirmRunning = vi.fn(async () => "cancel" as const)
  const quit = vi.fn()
  const request = createUserQuitAction({
    pending: () => false,
    remembered: () => "ask",
    remember: vi.fn(),
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
  const busy: QuitWork = {
    agents: 0,
    terminals: [{ project: "Alpha", command: "sleep" }],
    notebooks: 0,
  }
  const confirmRunning = vi.fn(async () => "cancel" as const)
  const quit = vi.fn()
  const request = createUserQuitAction({
    pending: () => false,
    remembered: () => "ask",
    remember: vi.fn(),
    work: async () => busy,
    choose: async () => pick("quit"),
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
  const onlyTerminals = runningWorkDialog({ agents: 0, terminals, notebooks: 0 })
  expect(onlyTerminals.message).toBe("2 terminals are still running a command.")
  expect(onlyTerminals.detail).toContain("Alpha: sleep")
  expect(onlyTerminals.detail).toContain("Beta: python")
  expect(onlyTerminals.buttons).toEqual([
    "Quit and stop terminals",
    "Keep running in background",
    "Cancel",
  ])
  const withAgent = runningWorkDialog({ agents: 1, terminals: terminals.slice(0, 1), notebooks: 0 })
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
  const onlyTerminals = confirmStopDialog({ agents: 0, terminals, notebooks: 0 })
  expect(onlyTerminals.message).toBe("1 terminal is still running a command.")
  expect(onlyTerminals.detail).toContain("Alpha: sleep")
  expect(onlyTerminals.buttons).toEqual(["Quit and stop terminals", "Cancel"])
  const withAgents = confirmStopDialog({ agents: 2, terminals, notebooks: 0 })
  expect(withAgents.message).toBe("2 agents are still running.")
  expect(withAgents.detail).toContain("Agents or results fetching are currently running.")
  expect(withAgents.detail).not.toContain("background")
  expect(withAgents.detail).toContain("Alpha: sleep")
  expect(withAgents.buttons).toEqual(["Quit and stop agents", "Cancel"])
})

test("open notebooks alone get the running-work confirmation", async () => {
  const notebooks: QuitWork = { agents: 0, terminals: [], notebooks: 2 }
  const confirmRunning = vi.fn(async () => "cancel" as const)
  const quit = vi.fn()
  const request = createUserQuitAction({
    pending: () => false,
    remembered: () => "ask",
    remember: vi.fn(),
    work: async () => notebooks,
    choose: async () => pick("quit"),
    confirmRunning,
    quit,
    background: vi.fn(),
    error: vi.fn(),
  })
  await request()
  expect(confirmRunning).toHaveBeenCalledWith(notebooks)
  expect(quit).not.toHaveBeenCalled()
})

test("the quit dialogs name open notebooks and say to save them first", () => {
  const onlyNotebooks = runningWorkDialog({ agents: 0, terminals: [], notebooks: 1 })
  expect(onlyNotebooks.message).toBe("1 notebook is still open.")
  expect(onlyNotebooks.detail).toContain(
    "Quitting also stops the server of 1 open notebook. Save the notebook in its tab first.",
  )
  expect(onlyNotebooks.buttons).toEqual([
    "Quit and stop notebooks",
    "Keep running in background",
    "Cancel",
  ])
  const withTerminal = runningWorkDialog({
    agents: 0,
    terminals: [{ project: "Alpha", command: "sleep" }],
    notebooks: 2,
  })
  expect(withTerminal.message).toBe("1 terminal is still running a command.")
  expect(withTerminal.detail).toContain("Alpha: sleep")
  expect(withTerminal.detail).toContain(
    "Quitting also stops the servers of 2 open notebooks. Save each notebook in its tab first.",
  )
  const logout = confirmStopDialog({ agents: 1, terminals: [], notebooks: 1 })
  expect(logout.detail).toContain("Save the notebook in its tab first.")
  expect(confirmStopDialog({ agents: 0, terminals: [], notebooks: 3 }).buttons).toEqual([
    "Quit and stop notebooks",
    "Cancel",
  ])
})
