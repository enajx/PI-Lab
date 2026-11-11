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

type QuitChoice = "quit" | "background" | "cancel"

/**
 * The Quit dialog choice saved with "Remember Move to background", or "ask" (the
 * default). Quit is never remembered.
 */
export type RememberedQuitChoice = "ask" | "background"

interface UserQuitDependencies {
  pending(): boolean
  work(): Promise<QuitWork>
  /** Read after `work()`, which starts the full runtime that holds the setting. */
  remembered(): RememberedQuitChoice
  /** The first Quit dialog: the chosen button and whether "Remember Move to background" is ticked. */
  choose(work: QuitWork): Promise<{ choice: QuitChoice; remember: boolean }>
  confirmRunning(work: QuitWork): Promise<QuitChoice>
  /** Save a ticked Move to background so later quits skip the dialogs. */
  remember(choice: "background"): void
  quit(): void
  background(): void
  error(error: unknown): void
}

/**
 * Confirm explicit user quit actions and separately confirm stopping running work
 * (agents, fetching, or terminals running a command); idle shells are stopped
 * without a second prompt. Programmatic shutdown uses its existing guard.
 *
 * A remembered "background" skips both dialogs and moves PI Lab to the
 * background. Only Move to background can be remembered: a ticked box is
 * saved only when the user picks Move to background in the first dialog;
 * Quit and Cancel never save.
 */
export function createUserQuitAction(dependencies: UserQuitDependencies): () => Promise<void> {
  let choosing = false

  async function decide(): Promise<QuitChoice> {
    const work = await dependencies.work()
    const remembered = dependencies.remembered()
    if (remembered !== "ask") return remembered
    const { choice, remember } = await dependencies.choose(work)
    if (choice === "cancel") return choice
    if (choice === "background") {
      if (remember) dependencies.remember("background")
      return choice
    }
    const latest = await dependencies.work()
    return hasRunningWork(latest) ? await dependencies.confirmRunning(latest) : "quit"
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
 * Text and buttons of the second Quit confirmation. Buttons are ordered
 * quit, background, cancel. Agent wording is unchanged; busy terminals are
 * listed as "project: command".
 */
export function runningWorkDialog(work: QuitWork): {
  message: string
  detail: string
  buttons: [string, string, string]
} {
  const list = terminalList(work)
  const notebooks = notebookLine(work)
  if (work.agents > 0)
    return {
      message: workMessage(work),
      detail: paragraphs([
        "Agents or results fetching are currently running. Quit and stop agents ends that work. Keep agents running in background leaves PI Lab and the work running.",
        list,
        notebooks,
      ]),
      buttons: ["Quit and stop agents", "Keep agents running in background", "Cancel"],
    }
  if (work.terminals.length === 0)
    return {
      message: workMessage(work),
      detail: paragraphs([
        notebooks,
        "Keep running in background leaves PI Lab and the notebooks running.",
      ]),
      buttons: ["Quit and stop notebooks", "Keep running in background", "Cancel"],
    }
  return {
    message: workMessage(work),
    detail: paragraphs([
      list,
      notebooks,
      "Keep running in background leaves PI Lab and the terminals running.",
    ]),
    buttons: ["Quit and stop terminals", "Keep running in background", "Cancel"],
  }
}

/**
 * Text and buttons for a quit PI Lab did not start, such as macOS logout,
 * restart or shutdown: same wording as {@link runningWorkDialog}, but only
 * quit and cancel, since the app cannot stay in the background.
 */
export function confirmStopDialog(work: QuitWork): {
  message: string
  detail: string
  buttons: [string, string]
} {
  const list = terminalList(work)
  const notebooks = notebookLine(work)
  if (work.agents > 0)
    return {
      message: workMessage(work),
      detail: paragraphs([
        "Agents or results fetching are currently running. Quit and stop agents ends that work.",
        list,
        notebooks,
      ]),
      buttons: ["Quit and stop agents", "Cancel"],
    }
  return {
    message: workMessage(work),
    detail: paragraphs([list, notebooks]),
    buttons: [
      work.terminals.length === 0 ? "Quit and stop notebooks" : "Quit and stop terminals",
      "Cancel",
    ],
  }
}
