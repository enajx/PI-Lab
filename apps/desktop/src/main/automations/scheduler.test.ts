// Unit tests for the automations scheduler (AGENTS.md §1 / §14): a temp-file
// SQLite DB with the real generated migrations, an INJECTED clock, and an
// INJECTED fire function — no real time, no agents, no PTYs. We seed automations
// directly, advance the clock, tick, and assert what fired and how nextRunAt
// advanced.
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type Automation,
  automations,
  type NewAutomation,
  projects,
  runMigrations,
  type SkipperDatabase,
} from "@skipper/local-db"
import type Database from "better-sqlite3"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { AutomationScheduler } from "./scheduler"

let db: SkipperDatabase
let sqlite: Database.Database
let dataDir: string
let projectId: string

// A fixed clock anchor (a Monday 08:00 UTC) so every case is deterministic.
const T0 = new Date("2026-06-22T08:00:00.000Z").getTime()
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(join(tmpdir(), "skipper-sched-")))
  const result = runMigrations(join(dataDir, "local.db"))
  db = result.db
  sqlite = result.sqlite
  const project = db
    .insert(projects)
    .values({ repoPath: join(dataDir, "repo"), name: "Repo" })
    .returning()
    .get()
  projectId = project.id
})

afterEach(async () => {
  sqlite.close()
  await rm(dataDir, { recursive: true, force: true })
})

/** Seed an automation row, defaulting the recurrence to daily 09:00 UTC. */
function seedAutomation(overrides: Partial<NewAutomation> = {}): Automation {
  return db
    .insert(automations)
    .values({
      projectId,
      agentId: "claude-code",
      name: "Nightly",
      prompt: "Run the nightly check",
      recurrenceRule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      startAt: T0 - DAY,
      timezone: "UTC",
      enabled: true,
      nextRunAt: T0 + HOUR, // 09:00 UTC, one hour after the clock anchor
      ...overrides,
    })
    .returning()
    .get()
}

/** A capturing fake fire — records every (automationId, scheduledFor) it sees. */
function makeFire() {
  const calls: Array<{ automationId: string; scheduledFor: number }> = []
  const fire = async (args: { automation: Automation; scheduledFor: number }) => {
    calls.push({ automationId: args.automation.id, scheduledFor: args.scheduledFor })
  }
  return { fire, calls }
}

function reload(id: string): Automation {
  const row = db.select().from(automations).where(eq(automations.id, id)).get()
  if (!row) throw new Error(`automation ${id} vanished`)
  return row
}

describe("AutomationScheduler.tick", () => {
  test("does not fire an automation that is not yet due", async () => {
    const automation = seedAutomation() // due at T0 + HOUR
    const { fire, calls } = makeFire()
    // Clock is exactly T0 — before nextRunAt.
    const scheduler = new AutomationScheduler({ db, fire, now: () => T0 })

    const fired = await scheduler.tick()
    expect(fired).toBe(0)
    expect(calls).toHaveLength(0)
    // nextRunAt is unchanged.
    expect(reload(automation.id).nextRunAt).toBe(automation.nextRunAt)
  })

  test("fires a due automation, records the scheduledFor, and advances nextRunAt", async () => {
    const automation = seedAutomation() // due at T0 + HOUR (09:00 UTC)
    const { fire, calls } = makeFire()
    // Clock is past the due instant.
    const scheduler = new AutomationScheduler({ db, fire, now: () => T0 + 2 * HOUR })

    const fired = await scheduler.tick()
    expect(fired).toBe(1)
    expect(calls).toEqual([{ automationId: automation.id, scheduledFor: automation.nextRunAt }])

    // nextRunAt advanced to the following day's 09:00 UTC.
    const after = reload(automation.id)
    expect(after.nextRunAt).toBe(new Date("2026-06-23T09:00:00.000Z").getTime())
    expect(after.enabled).toBe(true)
  })

  test("a disabled automation never fires even when its nextRunAt is in the past", async () => {
    seedAutomation({ enabled: false, nextRunAt: T0 - HOUR })
    const { fire, calls } = makeFire()
    const scheduler = new AutomationScheduler({ db, fire, now: () => T0 })

    const fired = await scheduler.tick()
    expect(fired).toBe(0)
    expect(calls).toHaveLength(0)
  })

  test("disables an automation whose recurrence is exhausted on fire", async () => {
    // COUNT=1 anchored a day ago: the single occurrence is already past, so after
    // firing the due instant there is no next — it disables.
    const automation = seedAutomation({
      recurrenceRule: "FREQ=DAILY;COUNT=1",
      startAt: T0 - DAY,
      nextRunAt: T0 - HOUR,
    })
    const { fire, calls } = makeFire()
    const scheduler = new AutomationScheduler({ db, fire, now: () => T0 })

    const fired = await scheduler.tick()
    expect(fired).toBe(1)
    expect(calls).toHaveLength(1)

    const after = reload(automation.id)
    expect(after.enabled).toBe(false)
    expect(after.nextRunAt).toBeNull()
  })

  test("advances nextRunAt before awaiting fire, so a throwing fire can't wedge the occurrence", async () => {
    const automation = seedAutomation()
    const throwingFire = async () => {
      throw new Error("boom")
    }
    const scheduler = new AutomationScheduler({ db, fire: throwingFire, now: () => T0 + 2 * HOUR })

    // tick swallows the fire error (dispatch records failures on the run row).
    const fired = await scheduler.tick()
    expect(fired).toBe(0) // a thrown fire is not counted as fired

    // …but nextRunAt was advanced regardless — the timer won't re-fire forever.
    expect(reload(automation.id).nextRunAt).toBe(new Date("2026-06-23T09:00:00.000Z").getTime())
  })

  test("fires multiple due automations in one tick, oldest-due first", async () => {
    const a = seedAutomation({ name: "A", nextRunAt: T0 - 2 * HOUR })
    const b = seedAutomation({ name: "B", nextRunAt: T0 - HOUR })
    const { fire, calls } = makeFire()
    const scheduler = new AutomationScheduler({ db, fire, now: () => T0 })

    const fired = await scheduler.tick()
    expect(fired).toBe(2)
    expect(calls.map((c) => c.automationId)).toEqual([a.id, b.id])
  })
})

describe("AutomationScheduler.reconcile", () => {
  test("recomputes nextRunAt from the clock and skips missed runs", async () => {
    // Stale nextRunAt far in the past (laptop closed overnight). Reconcile must
    // bump it to the next future occurrence, NOT replay missed ones.
    const automation = seedAutomation({ nextRunAt: T0 - 5 * DAY })
    const scheduler = new AutomationScheduler({ db, fire: makeFire().fire, now: () => T0 })

    scheduler.reconcile()

    const after = reload(automation.id)
    // T0 is 08:00 Monday; the next 09:00 UTC is the same day.
    expect(after.nextRunAt).toBe(T0 + HOUR)
    expect(after.nextRunAt).toBeGreaterThan(T0)
  })

  test("disables an automation with no future occurrences", async () => {
    const automation = seedAutomation({
      recurrenceRule: "FREQ=DAILY;UNTIL=20200101T000000Z",
    })
    const scheduler = new AutomationScheduler({ db, fire: makeFire().fire, now: () => T0 })

    scheduler.reconcile()

    const after = reload(automation.id)
    expect(after.enabled).toBe(false)
    expect(after.nextRunAt).toBeNull()
  })
})
