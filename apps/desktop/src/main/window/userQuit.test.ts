import { expect, test, vi } from "vitest"
import {
  createStopServerAction,
  createUserQuitAction,
  QUIT_DIALOG_BUTTONS,
  QUIT_DIALOG_CANCEL,
  type QuitWork,
  quitChoiceFromButton,
  quitDialogDetail,
  quitDialogNotebooks,
  stopWorkDialog,
} from "./userQuit"

type Choice = "quit" | "background" | "cancel"

const idle: QuitWork = { agents: 0, terminals: [], notebooks: 0 }
const agents = (count: number): QuitWork => ({ agents: count, terminals: [], notebooks: 0 })

/** Quit action with the given answers; every dependency is a spy. */
function harness(options: {
  remembered?: "ask" | "background"
  choice: Choice
  remember?: boolean
}) {
  const spies = {
    choose: vi.fn(async () => ({ choice: options.choice, remember: options.remember ?? false })),
    remember: vi.fn(),
    quit: vi.fn(),
    background: vi.fn(),
    error: vi.fn(),
  }
  const request = createUserQuitAction({
    pending: () => false,
    remembered: () => options.remembered ?? "ask",
    ...spies,
  })
  return { request, ...spies }
}

/** Stop action with the given work and confirmation answer; every dependency is a spy. */
function stopHarness(options: {
  work: QuitWork | "no answer"
  confirm?: "stop" | "cancel"
  pending?: boolean
}) {
  const spies = {
    work: vi.fn(() =>
      options.work === "no answer"
        ? new Promise<QuitWork>(() => undefined)
        : Promise.resolve(options.work),
    ),
    confirmStop: vi.fn(async () => options.confirm ?? "stop"),
    quitAndStop: vi.fn(),
    error: vi.fn(),
  }
  const request = createStopServerAction({
    pending: () => options.pending ?? false,
    workTimeoutMs: 50,
    ...spies,
  })
  return { request, ...spies }
}

test("the dialog buttons are Move to background, Quit, Cancel and map to their choices", () => {
  expect([...QUIT_DIALOG_BUTTONS]).toEqual(["Move to background", "Quit", "Cancel"])
  expect(QUIT_DIALOG_BUTTONS.map((_, index) => quitChoiceFromButton(index))).toEqual([
    "background",
    "quit",
    "cancel",
  ])
  expect(QUIT_DIALOG_BUTTONS[QUIT_DIALOG_CANCEL]).toBe("Cancel")
})

test("Cancel does nothing and never saves", async () => {
  const h = harness({ choice: "cancel", remember: true })
  await h.request()
  expect(h.quit).not.toHaveBeenCalled()
  expect(h.background).not.toHaveBeenCalled()
  expect(h.remember).not.toHaveBeenCalled()
})

test("Move to background moves to the background", async () => {
  const h = harness({ choice: "background" })
  await h.request()
  expect(h.background).toHaveBeenCalledOnce()
  expect(h.quit).not.toHaveBeenCalled()
  expect(h.remember).not.toHaveBeenCalled()
})

test("ticking Remember option with Move to background saves it", async () => {
  const h = harness({ choice: "background", remember: true })
  await h.request()
  expect(h.remember).toHaveBeenCalledExactlyOnceWith("background")
  expect(h.background).toHaveBeenCalledOnce()
})

test("a remembered Move to background skips the dialog", async () => {
  const h = harness({ remembered: "background", choice: "cancel" })
  await h.request()
  expect(h.choose).not.toHaveBeenCalled()
  expect(h.background).toHaveBeenCalledOnce()
  expect(h.quit).not.toHaveBeenCalled()
})

test("Quit quits and never saves", async () => {
  const h = harness({ choice: "quit", remember: true })
  await h.request()
  expect(h.quit).toHaveBeenCalledOnce()
  expect(h.background).not.toHaveBeenCalled()
  expect(h.remember).not.toHaveBeenCalled()
})

test("Stop Server and Agents with no running work asks for the Quit (drafts first) without a work dialog", async () => {
  const h = stopHarness({ work: idle })
  await h.request()
  expect(h.confirmStop).not.toHaveBeenCalled()
  expect(h.quitAndStop).toHaveBeenCalledOnce()
})

test("Stop Server and Agents with running work asks first, then stops the server and quits", async () => {
  const h = stopHarness({ work: agents(2), confirm: "stop" })
  await h.request()
  expect(h.confirmStop).toHaveBeenCalledExactlyOnceWith(agents(2))
  expect(h.quitAndStop).toHaveBeenCalledOnce()
})

test("cancelling the stop confirmation leaves everything running", async () => {
  const h = stopHarness({ work: agents(2), confirm: "cancel" })
  await h.request()
  expect(h.quitAndStop).not.toHaveBeenCalled()
  expect(h.error).not.toHaveBeenCalled()
})

test("a busy terminal or an open notebook alone gets the stop confirmation", async () => {
  const busy: QuitWork = {
    agents: 0,
    terminals: [{ project: "Alpha", command: "sleep" }],
    notebooks: 0,
  }
  const terminal = stopHarness({ work: busy, confirm: "cancel" })
  await terminal.request()
  expect(terminal.confirmStop).toHaveBeenCalledWith(busy)
  const notebook = stopHarness({
    work: { agents: 0, terminals: [], notebooks: 1 },
    confirm: "cancel",
  })
  await notebook.request()
  expect(notebook.confirmStop).toHaveBeenCalledOnce()
})

test("Stop Server with a server that does not answer says it is not reachable, stops nothing, and can be tried again", async () => {
  const h = stopHarness({ work: "no answer" })
  await h.request()
  expect(h.error).toHaveBeenCalledOnce()
  expect(String(h.error.mock.calls[0]?.[0])).toMatch(/not reachable.*may already be stopped/)
  expect(h.quitAndStop).not.toHaveBeenCalled()
  await h.request()
  expect(h.work).toHaveBeenCalledTimes(2)
})

test("the Quit dialog gets the open notebook count, or 0 (logged) when the server does not answer in time", async () => {
  const log = vi.fn()
  expect(await quitDialogNotebooks(async () => 3, 50, log)).toBe(3)
  expect(log).not.toHaveBeenCalled()
  const started = Date.now()
  expect(await quitDialogNotebooks(() => new Promise<number>(() => undefined), 50, log)).toBe(0)
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(await quitDialogNotebooks(async () => Promise.reject(new Error("closed")), 50, log)).toBe(
    0,
  )
  expect(log).toHaveBeenCalledTimes(2)
})

test("a quit already pending skips Stop Server and Agents", async () => {
  const h = stopHarness({ work: idle, pending: true })
  await h.request()
  expect(h.work).not.toHaveBeenCalled()
  expect(h.quitAndStop).not.toHaveBeenCalled()
})

test("concurrent Cmd+Q does not open duplicate dialogs", async () => {
  let finish!: (value: { choice: Choice; remember: boolean }) => void
  const choose = vi.fn(
    () =>
      new Promise<{ choice: Choice; remember: boolean }>((resolve) => {
        finish = resolve
      }),
  )
  const request = createUserQuitAction({
    pending: () => false,
    remembered: () => "ask",
    remember: vi.fn(),
    choose,
    quit: vi.fn(),
    background: vi.fn(),
    error: vi.fn(),
  })
  const first = request()
  await vi.waitFor(() => expect(choose).toHaveBeenCalledOnce())
  await request()
  expect(choose).toHaveBeenCalledOnce()
  finish({ choice: "cancel", remember: false })
  await first
})

test("a quit already pending skips the dialog", async () => {
  const choose = vi.fn()
  const request = createUserQuitAction({
    pending: () => true,
    remembered: () => "ask",
    remember: vi.fn(),
    choose,
    quit: vi.fn(),
    background: vi.fn(),
    error: vi.fn(),
  })
  await request()
  expect(choose).not.toHaveBeenCalled()
})

test("the stop dialog names agents, busy terminals and notebooks", () => {
  const terminals = [
    { project: "Alpha", command: "sleep" },
    { project: "Beta", command: "python" },
  ]
  const onlyTerminals = stopWorkDialog({ agents: 0, terminals, notebooks: 0 })
  expect(onlyTerminals.message).toBe("2 terminals are still running a command.")
  expect(onlyTerminals.detail).toContain("Alpha: sleep")
  expect(onlyTerminals.detail).toContain("Beta: python")
  expect(onlyTerminals.buttons).toEqual(["Stop server and agents", "Cancel"])
  const withAgent = stopWorkDialog({ agents: 1, terminals: terminals.slice(0, 1), notebooks: 0 })
  expect(withAgent.message).toBe("1 agent is still running.")
  expect(withAgent.detail).toContain("Alpha: sleep")
  expect(stopWorkDialog(agents(2)).message).toBe("2 agents are still running.")
  const onlyNotebooks = stopWorkDialog({ agents: 0, terminals: [], notebooks: 1 })
  expect(onlyNotebooks.message).toBe("1 notebook is still open.")
  expect(onlyNotebooks.detail).toContain(
    "Quitting also stops the server of 1 open notebook. Save the notebook in its tab first.",
  )
  const many = stopWorkDialog({ agents: 0, terminals: [], notebooks: 2 })
  expect(many.detail).toContain(
    "Quitting also stops the servers of 2 open notebooks. Save each notebook in its tab first.",
  )
})

test("the Quit dialog names open notebooks so the user can cancel and save them", () => {
  const plain =
    "Projects, agents and routines keep running on the PI Lab server after you quit. Move to background also keeps the menu-bar icon."
  expect(quitDialogDetail(0, false)).toBe(plain)
  expect(quitDialogDetail(2, false)).toBe(
    `${plain}\n\n2 notebooks are open. Their servers stop when PI Lab quits; save them first.`,
  )
  expect(quitDialogDetail(1, false)).toBe(
    `${plain}\n\n1 notebook is open. Its server stops when PI Lab quits; save it first.`,
  )
})

test("with Local server set to Only while PI Lab is open, the Quit dialog says the server and agents stop", () => {
  expect(quitDialogDetail(0, true)).toBe(
    "This Mac's PI Lab server, its agents and routines stop when you quit (Settings > Machines > Local server). Move to background keeps them running with the menu-bar icon.",
  )
})
