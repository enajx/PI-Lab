import type { ActivityRegistryChange, ActivityTimer } from "../activity"
import {
  CAFFEINE_AUDIT_MS,
  CAFFEINE_GRACE_MS,
  type CaffeineControllerDependencies,
  type CaffeineControllerPort,
  type CaffeineScope,
  type CaffeineSettings,
  type CaffeineStatus,
  type PowerBlockerKind,
} from "./types"

function blockerKind(scope: CaffeineScope): PowerBlockerKind {
  return scope === "system-only" ? "prevent-app-suspension" : "prevent-display-sleep"
}

/**
 * App-lifetime owner of Electron's power-save blocker.
 *
 * Auto combines durable agent/workflow activity with explicitly reported
 * terminal and meaningful-operation activity. A single grace deadline covers
 * all sources, so one source becoming idle cannot release a blocker while
 * another is still working.
 */
export class CaffeineController implements CaffeineControllerPort {
  private settings: CaffeineSettings
  private blockerId: number | null = null
  private registryWorking: boolean
  private lastActivityAt: number | null = null
  private readonly meaningfulActivity = new Map<string, number>()
  private releaseTimer: ActivityTimer | null = null
  private auditTimer: ActivityTimer | null = null
  private readonly unsubscribeActivity: () => void
  private disposed = false

  constructor(private readonly dependencies: CaffeineControllerDependencies) {
    this.settings = { ...dependencies.initialSettings }
    this.registryWorking = dependencies.activity.snapshot().hasWorkingActivity
    this.unsubscribeActivity = dependencies.activity.subscribe((change) => {
      this.handleRegistryChange(change)
    })
    this.reconcile()
    this.scheduleAudit()
  }

  status(): CaffeineStatus {
    return { ...this.settings, held: this.isHeld() }
  }

  configure(settings: CaffeineSettings): CaffeineStatus {
    const scopeChanged = settings.scope !== this.settings.scope
    this.settings = { ...settings }
    if (scopeChanged && this.blockerId !== null) this.releaseBlocker()
    this.reconcile()
    return this.status()
  }

  markTerminalActivity(): void {
    this.recordActivity(this.dependencies.clock.now())
  }

  beginMeaningfulActivity(tag: string): () => void {
    if (tag.length === 0) throw new Error("Meaningful caffeine activity requires a tag")
    this.meaningfulActivity.set(tag, (this.meaningfulActivity.get(tag) ?? 0) + 1)
    this.recordActivity(this.dependencies.clock.now())
    let ended = false
    return () => {
      if (ended) return
      ended = true
      const count = this.meaningfulActivity.get(tag)
      if (count === undefined) return
      if (count === 1) this.meaningfulActivity.delete(tag)
      else this.meaningfulActivity.set(tag, count - 1)
      this.recordActivity(this.dependencies.clock.now())
    }
  }

  /** Always release the live Electron blocker during application shutdown. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeActivity()
    this.releaseTimer?.cancel()
    this.releaseTimer = null
    this.auditTimer?.cancel()
    this.auditTimer = null
    this.releaseBlocker()
  }

  private handleRegistryChange(change: ActivityRegistryChange): void {
    const activityAt = change.activityEvents
      .filter((event) => event.phase === "acquire" || event.phase === "working")
      .reduce<number | null>((latest, event) => Math.max(latest ?? event.at, event.at), null)
    const stoppedWorking = this.registryWorking && !change.snapshot.hasWorkingActivity
    this.registryWorking = change.snapshot.hasWorkingActivity

    if (activityAt !== null) {
      this.recordActivity(activityAt)
      return
    }
    if (stoppedWorking) {
      this.recordActivity(this.dependencies.clock.now())
      return
    }
    this.reconcile()
  }

  private recordActivity(at: number): void {
    this.lastActivityAt = Math.max(this.lastActivityAt ?? at, at)
    this.reconcile()
  }

  private hasActiveWork(): boolean {
    return this.registryWorking || this.meaningfulActivity.size > 0
  }

  private isWithinGrace(): boolean {
    return (
      this.lastActivityAt !== null &&
      this.dependencies.clock.now() - this.lastActivityAt < CAFFEINE_GRACE_MS
    )
  }

  private shouldHold(): boolean {
    if (this.settings.mode === "off") return false
    if (this.settings.mode === "on") return true
    return this.hasActiveWork() || this.isWithinGrace()
  }

  private isHeld(): boolean {
    if (this.blockerId === null) return false
    if (this.dependencies.power.isStarted(this.blockerId)) return true
    this.blockerId = null
    return false
  }

  private reconcile(): void {
    if (this.disposed) return
    this.releaseTimer?.cancel()
    this.releaseTimer = null

    const shouldHold = this.shouldHold()
    const held = this.isHeld()
    if (shouldHold && !held) this.acquireBlocker()
    if (!shouldHold && held) this.releaseBlocker()

    if (
      this.settings.mode === "auto" &&
      this.blockerId !== null &&
      !this.hasActiveWork() &&
      this.lastActivityAt !== null
    ) {
      const elapsed = Math.max(0, this.dependencies.clock.now() - this.lastActivityAt)
      const remaining = Math.max(0, CAFFEINE_GRACE_MS - elapsed)
      if (remaining > 0) {
        this.releaseTimer = this.dependencies.scheduler.schedule(remaining, () => {
          this.releaseTimer = null
          this.reconcile()
        })
      }
    }
  }

  private acquireBlocker(): void {
    this.blockerId = this.dependencies.power.start(blockerKind(this.settings.scope))
  }

  private releaseBlocker(): void {
    const id = this.blockerId
    this.blockerId = null
    if (id !== null && this.dependencies.power.isStarted(id)) this.dependencies.power.stop(id)
  }

  private scheduleAudit(): void {
    this.auditTimer = this.dependencies.scheduler.schedule(CAFFEINE_AUDIT_MS, () => {
      this.auditTimer = null
      this.reconcile()
      if (!this.disposed) this.scheduleAudit()
    })
  }
}

/** Run one explicitly tagged process/data operation with reliable release. */
export async function withMeaningfulActivity<T>(
  controller: CaffeineControllerPort,
  tag: string,
  operation: () => Promise<T>,
): Promise<T> {
  const finish = controller.beginMeaningfulActivity(tag)
  return Promise.resolve().then(operation).finally(finish)
}
