import type { BusyTerminal } from "../terminal/busyTerminals"

/** Work an explicit Quit would stop: agents (including fetching) and busy terminals. */
export interface QuitWork {
  agents: number
  terminals: BusyTerminal[]
}

interface UserQuitDependencies {
  pending(): boolean
  work(): Promise<QuitWork>
  choose(work: QuitWork): Promise<"quit" | "background" | "cancel">
  confirmRunning(work: QuitWork): Promise<"quit" | "background" | "cancel">
  quit(): void
  background(): void
  error(error: unknown): void
}

/**
 * Confirm explicit user quit actions and separately confirm stopping running work
 * (agents, fetching, or terminals running a command); idle shells are stopped
 * without a second prompt. Programmatic shutdown uses its existing guard.
 */
export function createUserQuitAction(dependencies: UserQuitDependencies): () => Promise<void> {
  let choosing = false
  return async () => {
    if (choosing || dependencies.pending()) return
    choosing = true
    await dependencies
      .work()
      .then(dependencies.choose)
      .then(async (choice) => {
        if (choice !== "quit") return choice
        const work = await dependencies.work()
        return work.agents > 0 || work.terminals.length > 0
          ? dependencies.confirmRunning(work)
          : "quit"
      })
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
