interface AgentQuitDependencies {
  pause: () => Promise<void>
  resume: () => void
  behavior: () => "stop" | "keep-running"
  count: () => Promise<number>
  confirm: (count: number) => Promise<"cancel" | "stop" | "settings">
  stop: () => Promise<void>
  settings: () => void
}

/** Apply one quit policy to every registered agent execution mode. */
export async function prepareAgentQuit(dependencies: AgentQuitDependencies): Promise<boolean> {
  let approved = false
  try {
    await dependencies.pause()
    if (dependencies.behavior() === "keep-running") {
      approved = true
      return true
    }
    const count = await dependencies.count()
    if (count > 0) {
      const choice = await dependencies.confirm(count)
      if (choice === "settings") dependencies.settings()
      if (choice !== "stop") return false
    }
    await dependencies.stop()
    approved = true
    return true
  } finally {
    if (!approved) dependencies.resume()
  }
}
