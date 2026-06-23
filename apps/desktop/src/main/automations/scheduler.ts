import { type Automation, automations, type SkipperDatabase } from "@skipper/local-db"
import { nextOccurrence } from "@skipper/shared"
import { and, asc, eq, isNotNull, lte } from "drizzle-orm"
import type { FireAutomation } from "./dispatch"

/**
 * Local scheduled-agent-run engine, in the Electron main process (AGENTS.md §1
 * — Automations, §6 — boot sequence).
 *
 * "When" lives here — the timer, the due-sweep, and `nextRunAt` advancement.
 * "What happens on fire" lives in `dispatch.ts` (record a run row, launch the
 * agent through the shared session-start flow). Keeping that split lets the
 * scheduler be unit-tested with an *injected clock* and an *injected fire*, so
 * no real time, agents, or PTYs are involved (AGENTS.md §14).
 *
 * Persistence is the local SQLite DB, so a schedule survives a restart: on
 * `start()` we reconcile (recompute every enabled automation's `nextRunAt` from
 * the current clock — a laptop closed overnight skips missed runs rather than
 * firing a stale burst), then tick on a coarse interval.
 *
 * Overlap guard: a slow/overlapping tick cannot double-fire — `nextRunAt` is
 * advanced *before* `fire()` is awaited, and `dispatch` additionally dedups on
 * the unique `(automationId, scheduledFor)` run index. A re-entrant `tick()` is
 * also blocked by an in-flight flag.
 */

/** A clock, injectable so tests drive time deterministically. */
export type Clock = () => number

export interface AutomationSchedulerOptions {
  db: SkipperDatabase
  /** Fired for each due automation; production passes the real dispatcher. */
  fire: FireAutomation
  /** Current epoch-ms; defaults to `Date.now`. Injected in tests. */
  now?: Clock
  /** Sweep interval in ms; defaults to 30s. RRULE presets are minute-aligned. */
  intervalMs?: number
}

const DEFAULT_INTERVAL_MS = 30_000

export class AutomationScheduler {
  private readonly db: SkipperDatabase
  private readonly fire: FireAutomation
  private readonly now: Clock
  private readonly intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(options: AutomationSchedulerOptions) {
    this.db = options.db
    this.fire = options.fire
    this.now = options.now ?? Date.now
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  }

  /** Recompute an automation's next fire instant from a reference, or null when exhausted. */
  private computeNextRunAt(automation: Automation, after: number): number | null {
    const next = nextOccurrence(automation.recurrenceRule, {
      after: new Date(after),
      timezone: automation.timezone,
      startAt: new Date(automation.startAt),
    })
    return next ? next.getTime() : null
  }

  /**
   * Boot reconcile: for every enabled automation, recompute `nextRunAt` from the
   * current clock (skip-missed-runs policy). Disable any whose recurrence is
   * exhausted. Pure DB work — no firing.
   */
  reconcile(): void {
    const now = this.now()
    const enabled = this.db.select().from(automations).where(eq(automations.enabled, true)).all()

    for (const automation of enabled) {
      const next = this.computeNextRunAt(automation, now)
      if (next === null) {
        this.db
          .update(automations)
          .set({ enabled: false, nextRunAt: null, updatedAt: now })
          .where(eq(automations.id, automation.id))
          .run()
        continue
      }
      if (next !== automation.nextRunAt) {
        this.db
          .update(automations)
          .set({ nextRunAt: next })
          .where(eq(automations.id, automation.id))
          .run()
      }
    }
  }

  /**
   * One evaluate tick: fire every enabled automation that is due
   * (`nextRunAt <= now`), advancing its `nextRunAt` *first* (disabling it when
   * the recurrence is exhausted) so a fire that throws can't wedge the timer on
   * the same occurrence forever. Re-entrancy is blocked by `ticking`.
   *
   * Returns the number of automations fired (handy for tests).
   */
  async tick(): Promise<number> {
    if (this.ticking) return 0
    this.ticking = true
    try {
      const now = this.now()
      const due = this.db
        .select()
        .from(automations)
        .where(
          and(
            eq(automations.enabled, true),
            isNotNull(automations.nextRunAt),
            lte(automations.nextRunAt, now),
          ),
        )
        .orderBy(asc(automations.nextRunAt))
        .all()

      let fired = 0
      for (const automation of due) {
        const scheduledFor = automation.nextRunAt ?? now
        const next = this.computeNextRunAt(automation, now)
        this.db
          .update(automations)
          .set(
            next === null
              ? { enabled: false, nextRunAt: null, updatedAt: now }
              : { nextRunAt: next },
          )
          .where(eq(automations.id, automation.id))
          .run()

        try {
          await this.fire({ automation, scheduledFor })
          fired++
        } catch {
          // A failed fire must not kill the loop; dispatch already records the
          // failure on the run row.
        }
      }
      return fired
    } finally {
      this.ticking = false
    }
  }

  /** Start the timer (idempotent). Reconciles on boot, then ticks on the interval. */
  start(): void {
    if (this.timer) return
    this.reconcile()
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        // A failed tick must not kill the timer.
      })
    }, this.intervalMs)
    // Don't keep the Node/Electron event loop alive purely for the scheduler.
    this.timer.unref?.()
  }

  /** Stop the timer (idempotent). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
