import type { BusyTerminal } from "../terminal/busyTerminals"

/** Work an explicit Quit would stop: agents (including fetching) and busy terminals. */
export interface QuitWork {
  agents: number
  terminals: BusyTerminal[]
}

type QuitChoice = "quit" | "background" | "cancel"

/** The Quit dialog choice saved with "Remember my choice", or "ask" (the default). */
export type RememberedQuitChoice = "ask" | "background" | "quit"

interface UserQuitDependencies {
  pending(): boolean
  work(): Promise<QuitWork>
  /** Read after `work()`, which starts the full runtime that holds the setting. */
  remembered(): RememberedQuitChoice
  /** The first Quit dialog: the chosen button and whether "Remember my choice" is ticked. */
  choose(work: QuitWork): Promise<{ choice: QuitChoice; remember: boolean }>
  confirmRunning(work: QuitWork): Promise<QuitChoice>
  /** Save a ticked choice so later quits skip the dialogs. */
  remember(choice: "background" | "quit"): void
  quit(): void
  background(): void
  error(error: unknown): void
}

/**
 * Confirm explicit user quit actions and separately confirm stopping running work
 * (agents, fetching, or terminals running a command); idle shells are stopped
 * without a second prompt. Programmatic shutdown uses its existing guard.
 *
 * A remembered choice skips both dialogs: "background" moves PI Lab to the
 * background, "quit" quits and stops running work. A ticked "Remember my
 * choice" is saved only when that choice goes ahead: Cancel (in either dialog)
 * never saves, and a ticked Quit is saved only if the quit happens.
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
    const final =
      latest.agents > 0 || latest.terminals.length > 0
        ? await dependencies.confirmRunning(latest)
        : "quit"
    if (final === "quit" && remember) dependencies.remember("quit")
    return final
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

/** "N agents are still running." or "N terminals are still running a command." */
function workMessage(work: QuitWork): string {
  if (work.agents > 0)
    return `${work.agents} agent${work.agents === 1 ? " is" : "s are"} still running.`
  const count = work.terminals.length
  return `${count} terminal${count === 1 ? " is" : "s are"} still running a command.`
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
  if (work.agents > 0)
    return {
      message: workMessage(work),
      detail: [
        "Agents or results fetching are currently running. Quit and stop agents ends that work. Keep agents running in background leaves PI Lab and the work running.",
        list,
      ]
        .filter(Boolean)
        .join("\n\n"),
      buttons: ["Quit and stop agents", "Keep agents running in background", "Cancel"],
    }
  return {
    message: workMessage(work),
    detail: `${list}\n\nKeep running in background leaves PI Lab and the terminals running.`,
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
  if (work.agents > 0)
    return {
      message: workMessage(work),
      detail: [
        "Agents or results fetching are currently running. Quit and stop agents ends that work.",
        list,
      ]
        .filter(Boolean)
        .join("\n\n"),
      buttons: ["Quit and stop agents", "Cancel"],
    }
  return {
    message: workMessage(work),
    detail: list,
    buttons: ["Quit and stop terminals", "Cancel"],
  }
}
