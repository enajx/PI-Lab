import { assessReleaseCompatibility, type DataCompatibility } from "./compatibility"
import type { PublicUpdateChannel } from "./release"

export type UpdateStatus =
  | { kind: "checking" }
  | { kind: "idle" }
  | { kind: "ready"; version: string }
  | { kind: "restart-required" }
  | { kind: "waiting-for-compatible-release"; version: string; reason: string }
  | { kind: "error"; message: string }

/** Keep Electron's updater behind a small boundary that can be tested. */
export interface UpdateEngine {
  configure(channel: PublicUpdateChannel): void
  onDownloaded(listener: (candidate: { version: string; compatibility: unknown }) => void): void
  onUnavailable(listener: () => void): void
  onError(listener: (error: Error) => void): void
  check(): Promise<void>
  install(restart: boolean): void
}

/** Manage the chosen feed and prevent stale downloads after a channel change. */
export class PublicUpdateController {
  private selectedChannel: PublicUpdateChannel | null = null
  private status: UpdateStatus = { kind: "idle" }

  constructor(
    private readonly engine: UpdateEngine,
    private readonly currentCompatibility: DataCompatibility,
    private readonly publish: (status: UpdateStatus) => void,
    private readonly requestApprovedQuit: (install: () => void) => void,
    private readonly installOnApprovedQuit: (install: (() => void) | null) => void,
  ) {}

  current(): UpdateStatus {
    return this.status
  }

  private setStatus(status: UpdateStatus): void {
    this.status = status
    this.installOnApprovedQuit(status.kind === "ready" ? () => this.engine.install(false) : null)
    this.publish(status)
  }

  /** Configure and check only after the Quick Editor has reported readiness. */
  async start(channel: PublicUpdateChannel): Promise<void> {
    this.selectedChannel = channel
    this.engine.configure(channel)
    this.engine.onDownloaded(({ version, compatibility }) => {
      if (this.status.kind === "restart-required") return
      const reason = assessReleaseCompatibility(this.currentCompatibility, compatibility)
      if (reason) {
        this.setStatus({ kind: "waiting-for-compatible-release", version, reason })
        return
      }
      this.setStatus({ kind: "ready", version })
    })
    this.engine.onUnavailable(() => {
      if (
        this.status.kind === "restart-required" ||
        this.status.kind === "waiting-for-compatible-release"
      )
        return
      this.setStatus({ kind: "idle" })
    })
    this.engine.onError((error) => {
      if (this.status.kind === "restart-required") return
      this.setStatus({ kind: "error", message: error.message })
    })
    await this.checkAgain()
  }

  /** Periodically check again while running, without replacing a ready ZIP. */
  async checkAgain(): Promise<void> {
    if (this.status.kind === "ready" || this.status.kind === "restart-required") return
    if (this.status.kind !== "waiting-for-compatible-release") this.setStatus({ kind: "checking" })
    try {
      await this.engine.check()
    } catch (error) {
      if (this.current().kind !== "restart-required") {
        this.setStatus({
          kind: "error",
          message: String(error instanceof Error ? error.message : error),
        })
      }
    }
  }

  /** Change feeds on the next process start so an old staged file cannot install. */
  selectedChannelChanged(channel: PublicUpdateChannel): void {
    if (channel === this.selectedChannel) return
    this.setStatus({ kind: "restart-required" })
  }

  /** Ask the existing unsaved-work guard before replacing the running app. */
  restartToUpdate(): void {
    if (this.status.kind !== "ready") return
    this.requestApprovedQuit(() => this.engine.install(true))
  }
}
