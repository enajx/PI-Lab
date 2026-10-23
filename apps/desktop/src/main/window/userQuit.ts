interface UserQuitDependencies {
  pending(): boolean
  count(): Promise<number>
  choose(count: number): Promise<"quit" | "background" | "cancel">
  confirmRunning(count: number): Promise<"quit" | "background" | "cancel">
  quit(): void
  background(): void
  error(error: unknown): void
}

/** Confirm explicit user quit actions and separately confirm stopping running work; programmatic shutdown uses its existing guard. */
export function createUserQuitAction(dependencies: UserQuitDependencies): () => Promise<void> {
  let choosing = false
  return async () => {
    if (choosing || dependencies.pending()) return
    choosing = true
    await dependencies
      .count()
      .then(dependencies.choose)
      .then(async (choice) => {
        if (choice !== "quit") return choice
        const count = await dependencies.count()
        return count > 0 ? dependencies.confirmRunning(count) : "quit"
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
