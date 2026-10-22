/** Tracks launch setup only, so quit cannot miss a process still being registered. */
export class AgentLaunchLifecycle {
  private paused = false
  private readonly pending = new Set<Promise<unknown>>()

  run<T>(launch: () => Promise<T>): Promise<T> {
    if (this.paused)
      return Promise.reject(new Error("Agent launches are paused while quitting PI Lab"))
    const pending = Promise.resolve().then(launch)
    this.pending.add(pending)
    return pending.finally(() => {
      this.pending.delete(pending)
    })
  }

  /** Reject new launches and wait for existing launch setup, never agent completion. */
  async pause(): Promise<void> {
    this.paused = true
    await Promise.allSettled([...this.pending])
  }

  resume(): void {
    this.paused = false
  }
}

export const agentLaunchLifecycle = new AgentLaunchLifecycle()
