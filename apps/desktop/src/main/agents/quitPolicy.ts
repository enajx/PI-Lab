import type { QuitWork } from "../window/userQuit"

/**
 * How one approved quit treats running work:
 * - `end`: explicit Quit (Cmd+Q, menu, tray, last-window close), already confirmed; stop everything.
 * - `confirm-end`: any other quit, such as macOS logout or shutdown; ask only when
 *   agents, fetching or busy terminals run, then stop everything.
 * - `keep`: Restart to Update; agents, shells and Python runs keep running and reattach.
 */
export type QuitMode = "end" | "confirm-end" | "keep"

interface AgentQuitDependencies {
  mode: QuitMode
  pause: () => Promise<void>
  resume: () => void
  work: () => Promise<QuitWork>
  confirm: (work: QuitWork) => Promise<"stop" | "cancel">
  /** Stop agents, fetching, shells, Python runs and the PTY daemon. */
  stop: () => Promise<void>
}

/** Apply one quit policy to every agent execution mode and every terminal. */
export async function prepareAgentQuit(dependencies: AgentQuitDependencies): Promise<boolean> {
  let approved = false
  try {
    await dependencies.pause()
    if (dependencies.mode === "keep") {
      approved = true
      return true
    }
    if (dependencies.mode === "confirm-end") {
      const work = await dependencies.work()
      if (
        (work.agents > 0 || work.terminals.length > 0) &&
        (await dependencies.confirm(work)) !== "stop"
      )
        return false
    }
    await dependencies.stop()
    approved = true
    return true
  } finally {
    if (!approved) dependencies.resume()
  }
}
