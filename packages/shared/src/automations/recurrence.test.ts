import fc from "fast-check"
import { describe, expect, test } from "vitest"
import {
  buildRrule,
  describeSchedule,
  isValidRrule,
  matchPreset,
  nextOccurrence,
  type SchedulePreset,
  upcomingOccurrences,
} from "./recurrence"

const UTC = "UTC"

/** A fixed reference instant so every example is deterministic (no `now`). */
const REF = new Date("2026-06-22T08:00:00.000Z") // a Monday
const ANCHOR = new Date("2026-01-01T00:00:00.000Z")

describe("nextOccurrence — examples", () => {
  test("daily at 09:00 UTC returns the same day when reference is before 09:00", () => {
    const next = nextOccurrence("FREQ=DAILY;BYHOUR=9;BYMINUTE=0", {
      after: REF,
      timezone: UTC,
      startAt: ANCHOR,
    })
    expect(next?.toISOString()).toBe("2026-06-22T09:00:00.000Z")
  })

  test("daily at 09:00 UTC rolls to the next day when reference is past 09:00", () => {
    const next = nextOccurrence("FREQ=DAILY;BYHOUR=9;BYMINUTE=0", {
      after: new Date("2026-06-22T09:30:00.000Z"),
      timezone: UTC,
      startAt: ANCHOR,
    })
    expect(next?.toISOString()).toBe("2026-06-23T09:00:00.000Z")
  })

  test("hourly advances exactly one hour", () => {
    const next = nextOccurrence("FREQ=HOURLY", {
      after: new Date("2026-06-22T08:15:00.000Z"),
      timezone: UTC,
      startAt: ANCHOR,
    })
    expect(next?.toISOString()).toBe("2026-06-22T09:00:00.000Z")
  })

  test("weekdays skips the weekend (Friday -> Monday)", () => {
    // 2026-06-26 is a Friday; the next weekday 09:00 after Fri 10:00 is Monday.
    const next = nextOccurrence("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0", {
      after: new Date("2026-06-26T10:00:00.000Z"),
      timezone: UTC,
      startAt: ANCHOR,
    })
    expect(next?.getUTCDay()).toBe(1) // Monday
    expect(next?.toISOString()).toBe("2026-06-29T09:00:00.000Z")
  })

  test("respects a timezone offset — 09:00 America/New_York is 13:00 UTC (EDT)", () => {
    const next = nextOccurrence("FREQ=DAILY;BYHOUR=9;BYMINUTE=0", {
      after: REF,
      timezone: "America/New_York",
      startAt: ANCHOR,
    })
    // June -> EDT (UTC-4), so wall-clock 09:00 is 13:00 UTC.
    expect(next?.toISOString()).toBe("2026-06-22T13:00:00.000Z")
  })

  test("returns null past an UNTIL bound (exhaustion)", () => {
    const next = nextOccurrence("FREQ=DAILY;BYHOUR=9;BYMINUTE=0;UNTIL=20260101T000000Z", {
      after: REF,
      timezone: UTC,
      startAt: ANCHOR,
    })
    expect(next).toBeNull()
  })

  test("returns null once a COUNT is exhausted", () => {
    // COUNT=1: the only occurrence is the first one (on/after the anchor). A
    // reference well past it has nothing left.
    const next = nextOccurrence("FREQ=DAILY;COUNT=1", {
      after: REF,
      timezone: UTC,
      startAt: ANCHOR,
    })
    expect(next).toBeNull()
  })

  test("returns null for an empty or malformed rule (never throws)", () => {
    const opts = { after: REF, timezone: UTC, startAt: ANCHOR }
    expect(nextOccurrence("", opts)).toBeNull()
    expect(nextOccurrence("   ", opts)).toBeNull()
    expect(nextOccurrence("not an rrule", opts)).toBeNull()
  })
})

describe("nextOccurrence — properties", () => {
  // Arbitraries: unbounded recurring rules and reasonable anchors/references.
  // Every rule here lands an occurrence within a day of any reference, so
  // rrule.js never has to grind through a long internal walk (which keeps the
  // hundreds of generated cases fast). Sub-daily/long-walk rules are covered by
  // the example tests instead.
  const unboundedRule = fc.constantFrom(
    "FREQ=HOURLY",
    "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    "FREQ=DAILY;BYHOUR=0;BYMINUTE=0",
    "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0",
    "FREQ=WEEKLY;BYDAY=SU;BYHOUR=18;BYMINUTE=30",
  )
  const tz = fc.constantFrom(
    "UTC",
    "America/New_York",
    "Europe/Berlin",
    "Asia/Tokyo",
    "Australia/Sydney",
  )
  // Epoch-ms within a realistic window (2015..2035) so DST and leap years are
  // exercised; the anchor is kept close to the reference so a weekly rule's
  // first occurrence is never far from the reference (bounded rrule.js work).
  const epoch = fc.integer({ min: 1.42e12, max: 2.05e12 })
  // fast-check defaults to 100 runs; cap explicitly so the suite stays brisk
  // (each case does timezone math + an rrule.js walk). A generous Vitest timeout
  // guards against flakiness when the whole suite runs in parallel.
  const RUNS = { numRuns: 50 }
  const TIMEOUT = 20_000

  test(
    "the result is strictly after `after` (monotonic)",
    () => {
      fc.assert(
        fc.property(unboundedRule, tz, epoch, epoch, (rule, timezone, refMs, anchorMs) => {
          const result = nextOccurrence(rule, {
            after: new Date(refMs),
            timezone,
            startAt: new Date(anchorMs),
          })
          // These rules are unbounded, so an occurrence always exists.
          return result !== null && result.getTime() > refMs
        }),
        RUNS,
      )
    },
    TIMEOUT,
  )

  test(
    "is deterministic — same inputs give the same output",
    () => {
      fc.assert(
        fc.property(unboundedRule, tz, epoch, epoch, (rule, timezone, refMs, anchorMs) => {
          const opts = { after: new Date(refMs), timezone, startAt: new Date(anchorMs) }
          const a = nextOccurrence(rule, opts)
          const b = nextOccurrence(rule, opts)
          return a?.getTime() === b?.getTime()
        }),
        RUNS,
      )
    },
    TIMEOUT,
  )

  test(
    "iterating from the previous result yields a strictly increasing sequence",
    () => {
      fc.assert(
        fc.property(unboundedRule, tz, epoch, epoch, (rule, timezone, refMs, anchorMs) => {
          const startAt = new Date(anchorMs)
          let cursor = new Date(refMs)
          for (let i = 0; i < 3; i++) {
            const next = nextOccurrence(rule, { after: cursor, timezone, startAt })
            if (next === null) return false
            if (next.getTime() <= cursor.getTime()) return false
            cursor = next
          }
          return true
        }),
        RUNS,
      )
    },
    TIMEOUT,
  )

  test(
    "a COUNT bound exhausts: no occurrence exists far past the count window",
    () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 5 }), tz, epoch, (count, timezone, anchorMs) => {
          const startAt = new Date(anchorMs)
          const rule = `FREQ=DAILY;COUNT=${count}`
          // After (count + 1) days past the anchor, the bounded rule is exhausted.
          const after = new Date(anchorMs + (count + 2) * 24 * 60 * 60 * 1000)
          return nextOccurrence(rule, { after, timezone, startAt }) === null
        }),
        RUNS,
      )
    },
    TIMEOUT,
  )
})

describe("upcomingOccurrences", () => {
  test("returns exactly N strictly-increasing instants for an unbounded rule", () => {
    const items = upcomingOccurrences("FREQ=DAILY;BYHOUR=9;BYMINUTE=0", {
      after: REF,
      timezone: UTC,
      startAt: ANCHOR,
      count: 3,
    })
    expect(items).toHaveLength(3)
    const times = items.map((d) => d.getTime())
    const sorted = [...times].sort((a, b) => a - b)
    expect(times).toEqual(sorted)
    expect(new Set(times).size).toBe(times.length)
  })

  test("stops early when the recurrence is exhausted", () => {
    const items = upcomingOccurrences("FREQ=DAILY;COUNT=2", {
      after: new Date(ANCHOR.getTime() - 1000),
      timezone: UTC,
      startAt: ANCHOR,
      count: 10,
    })
    expect(items.length).toBeLessThanOrEqual(2)
  })
})

describe("isValidRrule", () => {
  test("accepts authored shapes, rejects junk", () => {
    expect(isValidRrule("FREQ=DAILY;BYHOUR=9;BYMINUTE=0")).toBe(true)
    expect(isValidRrule("FREQ=HOURLY")).toBe(true)
    expect(isValidRrule("")).toBe(false)
    expect(isValidRrule("BYHOUR=9")).toBe(false) // no FREQ
    expect(isValidRrule("garbage")).toBe(false)
  })
})

describe("buildRrule / matchPreset round-trip", () => {
  const presets: SchedulePreset[] = [
    { kind: "hourly" },
    { kind: "daily", hour: 9, minute: 0 },
    { kind: "weekdays", hour: 17, minute: 30 },
    { kind: "weekly", day: "WE", hour: 8, minute: 15 },
  ]

  for (const preset of presets) {
    test(`${preset.kind} survives build -> match`, () => {
      const matched = matchPreset(buildRrule(preset))
      expect(matched).toEqual(preset)
    })
  }

  test("an interval/monthly rule collapses to custom", () => {
    const matched = matchPreset("FREQ=MONTHLY;BYMONTHDAY=1")
    expect(matched.kind).toBe("custom")
  })

  // Property: building any authored preset always yields a valid, matchable rule.
  test("every authored preset builds to a valid RRULE", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant<SchedulePreset>({ kind: "hourly" }),
          fc
            .record({
              hour: fc.integer({ min: 0, max: 23 }),
              minute: fc.integer({ min: 0, max: 59 }),
            })
            .map((t): SchedulePreset => ({ kind: "daily", ...t })),
          fc
            .record({
              hour: fc.integer({ min: 0, max: 23 }),
              minute: fc.integer({ min: 0, max: 59 }),
            })
            .map((t): SchedulePreset => ({ kind: "weekdays", ...t })),
        ),
        (preset) => {
          const rule = buildRrule(preset)
          return isValidRrule(rule) && matchPreset(rule).kind === preset.kind
        },
      ),
    )
  })
})

describe("describeSchedule", () => {
  test("renders friendly cadences", () => {
    expect(describeSchedule("FREQ=HOURLY", { locale: "en-US" })).toBe("Hourly")
    expect(describeSchedule("FREQ=DAILY;BYHOUR=9;BYMINUTE=0", { locale: "en-US" })).toContain(
      "Daily",
    )
    expect(
      describeSchedule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0", { locale: "en-US" }),
    ).toContain("Weekdays")
    expect(
      describeSchedule("FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=10;BYMINUTE=0", { locale: "en-US" }),
    ).toContain("Weekends")
  })

  test("falls back to Custom for unhandled / bounded rules", () => {
    expect(describeSchedule("FREQ=MONTHLY;BYMONTHDAY=1")).toBe("Custom")
    expect(describeSchedule("FREQ=DAILY;COUNT=3")).toBe("Custom")
    expect(describeSchedule("nonsense")).toBe("Custom")
  })

  // Property: describeSchedule is total — never throws for any string.
  test("is total over arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const out = describeSchedule(input)
        return typeof out === "string" && out.length > 0
      }),
    )
  })
})
