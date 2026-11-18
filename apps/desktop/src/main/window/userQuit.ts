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

/** First Quit dialog: Quit leaves the server and all work running; "stop" ends them too. */
type QuitChoice = "quit" | "stop" | "background" | "cancel"

/**
 * The Quit dialog choice saved with "Remember option", or "ask" (the
 * default). Quit is never remembered.
 */
export type RememberedQuitChoice = "ask" | "background"

interface UserQuitDependencies {
  pending(): boolean
  remembered(): RememberedQuitChoice
  /** The first Quit dialog: the chosen button and whether "Remember option" is ticked. */
  choose(): Promise<{ choice: QuitChoice; remember: boolean }>
  /** Work the stop choice would end (agents, busy terminals, notebooks). */
  work(): Promise<QuitWork>
  /** Second dialog before stopping running work. */
  confirmStop(work: QuitWork): Promise<"stop" | "cancel">
  /** Save a ticked Move to background so later quits skip the dialogs. */
  remember(choice: "background"): void
  /** Stop every agent, terminal and notebook, then the server. */
  stopServer(): Promise<void>
  quit(): void
  background(): void
  error(error: unknown): void
}

/**
 * Explicit user Quit. The PI Lab server keeps projects, agents and routines
 * running after the app quits; the dialog offers to stop them as well, with
 * a second confirmation when work is running.
 *
 * A remembered "background" skips the dialog and moves PI Lab to the
 * background. Only Move to background can be remembered: a ticked box is
 * saved only when the user picks Move to background; the other choices never
 * save.
 */
export function createUserQuitAction(dependencies: UserQuitDependencies): () => Promise<void> {
  let choosing = false

  async function decide(): Promise<"quit" | "stop" | "background" | "cancel"> {
    const remembered = dependencies.remembered()
    if (remembered !== "ask") return remembered
    const { choice, remember } = await dependencies.choose()
    if (choice === "background" && remember) dependencies.remember("background")
    if (choice !== "stop") return choice
    const work = await dependencies.work()
    if (!hasRunningWork(work)) return "stop"
    return (await dependencies.confirmStop(work)) === "stop" ? "stop" : "cancel"
  }

  return async () => {
    if (choosing || dependencies.pending()) return
    choosing = true
    await decide()
      .then(async (choice) => {
        if (choice === "stop") {
          await dependencies.stopServer()
          dependencies.quit()
        }
        if (choice === "quit") dependencies.quit()
        if (choice === "background") dependencies.background()
      })
      .catch(dependencies.error)
      .finally(() => {
        choosing = false
      })
  }
}

/** The first Quit dialog's buttons, in the order {@link quitChoiceFromButton} reads them. */
export const QUIT_DIALOG_BUTTONS = [
  "Cancel",
  "Move to background",
  "Quit",
  "Quit and stop server and agents",
] as const

export function quitChoiceFromButton(index: number): QuitChoice {
  return index === 3 ? "stop" : index === 2 ? "quit" : index === 1 ? "background" : "cancel"
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
 * Text and buttons of the confirmation before "Quit and stop server and
 * agents" ends running work. Buttons are ordered stop, cancel.
 */
export function stopWorkDialog(work: QuitWork): {
  message: string
  detail: string
  buttons: [string, string]
} {
  return {
    message: workMessage(work),
    detail: paragraphs([
      "Stopping the server ends this work. Quit without stopping leaves it running on the PI Lab server.",
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
