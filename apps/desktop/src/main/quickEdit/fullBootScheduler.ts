/** Delay full-app work briefly so it does not compete with the quick editor's first paint. */
export class FullBootScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private started: Promise<void> | null = null

  constructor(
    private readonly start: () => Promise<void>,
    private readonly delayMs: number,
  ) {}

  /** Schedule background boot once the quick editor reports a focused caret. */
  schedule(): void {
    if (this.timer || this.started) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.startNow().catch(() => undefined)
    }, this.delayMs)
  }

  /** Start immediately when the user opens the full app, reusing any running boot. */
  startNow(): Promise<void> {
    this.cancel()
    if (!this.started) this.started = this.start()
    return this.started
  }

  /** Remove pending background work when PI Lab exits. */
  cancel(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
