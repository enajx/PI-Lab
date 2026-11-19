import type { BusyTerminal } from "../terminal/busyTerminals"

/** Work an explicit Quit would stop: agents (including fetching), busy terminals and notebooks. */
export interface QuitWork {
  agents: number
  terminals: BusyTerminal[]
  /** Notebook tabs whose servers run; their unsaved edits are lost on quit. */
  notebooks: number
}

/** True when quitting would stop any work, so the running-work dialog asks first. */
export function hasRunningWork(work: QuitWork): boolean {
  return work.agents > 0 || work.terminals.length > 0 || work.notebooks > 0
}

/** Quit dialog choice. Quit leaves the server and all work running. */
type QuitChoice = "quit" | "background" | "cancel"

/**
 * The Quit dialog choice saved with "Remember option", or "ask" (the
 * default). Quit is never remembered.
 */
export type RememberedQuitChoice = "ask" | "background"

interface UserQuitDependencies {
  pending(): boolean
  remembered(): RememberedQuitChoice
  /** The Quit dialog: the chosen button and whether "Remember option" is ticked. */
  choose(): Promise<{ choice: QuitChoice; remember: boolean }>
  /** Save a ticked Move to background so later quits skip the dialog. */
  remember(choice: "background"): void
  quit(): void
  background(): void
  error(error: unknown): void
}

/**
 * Explicit user Quit. The PI Lab server keeps projects, agents and routines
 * running after the app quits; stopping them is the separate
 * {@link createStopServerAction} (app menu and tray).
 *
 * A remembered "background" skips the dialog and moves PI Lab to the
 * background. Only Move to background can be remembered: a ticked box is
 * saved only when the user picks Move to background.
 */
export function createUserQuitAction(dependencies: UserQuitDependencies): () => Promise<void> {
  let choosing = false

  async function decide(): Promise<QuitChoice> {
    const remembered = dependencies.remembered()
    if (remembered !== "ask") return remembered
    const { choice, remember } = await dependencies.choose()
    if (choice === "background" && remember) dependencies.remember("background")
    return choice
  }

  return async () => {
    if (choosing || dependencies.pending()) return
    choosing = true
    await decide()
      .then((choice) => {
        if (choice === "quit") dependencies.quit()
        if (choice === "background") dependencies.background()
      })
      .catch(dependencies.error)
      .finally(() => {
        choosing = false
      })
  }
}

/** The Quit dialog's buttons, in the order {@link quitChoiceFromButton} reads them. */
export const QUIT_DIALOG_BUTTONS = ["Move to background", "Quit", "Cancel"] as const

/** Index of Cancel in {@link QUIT_DIALOG_BUTTONS} (the dialog's default and Esc choice). */
export const QUIT_DIALOG_CANCEL = 2

export function quitChoiceFromButton(index: number): QuitChoice {
  return index === 0 ? "background" : index === 1 ? "quit" : "cancel"
}

/** Reject with `message` when `work` has not settled after `ms`. */
function withinTime<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/**
 * The open notebook count for the Quit dialog. When the server fails or does
 * not answer within `ms`, the dialog opens without the notebook line (0) and
 * the reason is logged, so Cmd+Q never waits on an unreachable server.
 */
export function quitDialogNotebooks(
  count: () => Promise<number>,
  ms: number,
  log: (message: string) => void,
): Promise<number> {
  return withinTime(count(), ms, `no answer within ${ms} ms`).catch((error: unknown) => {
    log(`[pi-lab] open notebooks could not be counted for the Quit dialog: ${String(error)}`)
    return 0
  })
}

/** Shown when Stop Server and Agents gets no answer from the server. */
export const SERVER_UNREACHABLE = "The PI Lab server is not reachable. It may already be stopped."

interface StopServerDependencies {
  pending(): boolean
  /** Work stopping would end (agents, busy terminals, notebooks). */
  work(): Promise<QuitWork>
  /** How long {@link work} may take before the server counts as not reachable. */
  workTimeoutMs: number
  /** Confirmation shown only while work runs. */
  confirmStop(work: QuitWork): Promise<"stop" | "cancel">
  /**
   * Quit like the user's Quit (the renderer asks about unsaved drafts first),
   * then stop every agent, terminal and notebook, the PTY daemon and the
   * server, only once the quit is approved.
   */
  quitAndStop(): void
  error(error: unknown): void
}

/**
 * "Stop Server and Agents…" (app menu and tray): quits the app and ends all
 * PI Lab work on this machine, since the app cannot work without its server.
 * Asks first while work runs; the unsaved-drafts decision comes before
 * anything stops. A server that does not answer in time gets
 * {@link SERVER_UNREACHABLE} and the app stays open.
 */
export function createStopServerAction(dependencies: StopServerDependencies): () => Promise<void> {
  let running = false
  return async () => {
    if (running || dependencies.pending()) return
    running = true
    await withinTime(dependencies.work(), dependencies.workTimeoutMs, SERVER_UNREACHABLE)
      .then(async (work) => {
        if (hasRunningWork(work) && (await dependencies.confirmStop(work)) !== "stop") return
        dependencies.quitAndStop()
      })
      .catch(dependencies.error)
      .finally(() => {
        running = false
      })
  }
}

/**
 * Detail of the Quit dialog. Open notebook tabs are named: their servers stop
 * with the window, so the user can Cancel and save them first.
 */
export function quitDialogDetail(notebooks: number): string {
  const base =
    "Projects, agents and routines keep running on the PI Lab server after you quit. Move to background also keeps the menu-bar icon."
  if (notebooks === 0) return base
  const line =
    notebooks === 1
      ? "1 notebook is open. Its server stops when PI Lab quits; save it first."
      : `${notebooks} notebooks are open. Their servers stop when PI Lab quits; save them first.`
  return `${base}\n\n${line}`
}

/** "Quitting also stops …" followed by one "• project: command" line per busy terminal. */
function terminalList(work: QuitWork): string {
  const count = work.terminals.length
  if (count === 0) return ""
  const lines = work.terminals.map((terminal) => `• ${terminal.project}: ${terminal.command}`)
  return `Quitting also stops ${count === 1 ? "this terminal" : "these terminals"}:\n${lines.join("\n")}`
}

/** "Quitting also stops the server of 1 open notebook. …", or "" with no notebooks. */
function notebookLine(work: QuitWork): string {
  const count = work.notebooks
  if (count === 0) return ""
  return count === 1
    ? "Quitting also stops the server of 1 open notebook. Save the notebook in its tab first."
    : `Quitting also stops the servers of ${count} open notebooks. Save each notebook in its tab first.`
}

/** "N agents are still running.", "N terminals are still running a command." or "N notebooks are still open." */
function workMessage(work: QuitWork): string {
  if (work.agents > 0)
    return `${work.agents} agent${work.agents === 1 ? " is" : "s are"} still running.`
  const count = work.terminals.length
  if (count === 0)
    return `${work.notebooks} notebook${work.notebooks === 1 ? " is" : "s are"} still open.`
  return `${count} terminal${count === 1 ? " is" : "s are"} still running a command.`
}

/** The non-empty parts joined by blank lines. */
function paragraphs(parts: string[]): string {
  return parts.filter(Boolean).join("\n\n")
}

/**
 * Text and buttons of the confirmation before "Stop Server and Agents…" ends
 * running work. Buttons are ordered stop, cancel.
 */
export function stopWorkDialog(work: QuitWork): {
  message: string
  detail: string
  buttons: [string, string]
} {
  return {
    message: workMessage(work),
    detail: paragraphs([
      "Stopping the server ends this work and quits PI Lab.",
      terminalList(work),
      notebookLine(work),
    ]),
    buttons: ["Stop server and agents", "Cancel"],
  }
}

/**
 * Text and buttons for a quit PI Lab did not start (macOS logout, restart or
 * shutdown), which also ends the server and its work. Buttons: quit, cancel.
 */
export function logoutWorkDialog(work: QuitWork): {
  message: string
  detail: string
  buttons: [string, string]
} {
  return {
    message: workMessage(work),
    detail: paragraphs([
      "Logging out, restarting or shutting down stops this work.",
      terminalList(work),
      notebookLine(work),
    ]),
    buttons: ["Quit", "Cancel"],
  }
}
