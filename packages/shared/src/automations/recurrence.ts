/**
 * Recurrence engine for scheduled / looping agent runs (AGENTS.md "Scope" —
 * Automations). Given an RFC 5545 RRULE body, an anchor (`startAt`), and an IANA
 * timezone, it answers "what is the next instant this should fire, strictly
 * after some reference time?". That single question drives the whole scheduler:
 * computing the initial `nextRunAt`, advancing it after a fire, and re-anchoring
 * a paused automation on resume.
 *
 * Design notes:
 *   - **Pure & deterministic.** {@link nextOccurrence} is a pure function of its
 *     arguments — no `Date.now()`, no `new Date()` of "now", no hidden state. The
 *     same inputs always yield the same output, so it is property-testable
 *     (md/engineering/testing-and-build.md) and the scheduler can drive it off an injected clock.
 *   - **Wall-clock recurrence in a real timezone.** rrule.js is run on *floating*
 *     wall-clock dates (no `TZID`), because its `TZID` output drifts with the host
 *     process timezone. We feed it wall-clock-as-UTC dates, let it walk the
 *     recurrence calendar, then convert each occurrence back to a real UTC instant
 *     in the automation's configured zone. This keeps the calendar (e.g. "9am
 *     daily") stable across DST and across whatever timezone the machine runs in.
 *   - **Bounds respected.** `UNTIL` / `COUNT` exhaust the recurrence; once there
 *     is no occurrence after the reference time, the function returns `null`.
 */

import { TZDate } from "@date-fns/tz"
import { RRule } from "rrule"

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR"] as const
const WEEKENDS = ["SA", "SU"] as const
const DAY_ORDER = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const

const DAY_PLURAL: Record<string, string> = {
  MO: "Mondays",
  TU: "Tuesdays",
  WE: "Wednesdays",
  TH: "Thursdays",
  FR: "Fridays",
  SA: "Saturdays",
  SU: "Sundays",
}
const DAY_SHORT: Record<string, string> = {
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat",
  SU: "Sun",
}

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"

// ---------------------------------------------------------------------------
// Wall-clock <-> real-UTC conversion (the floating-date trick described above).
// ---------------------------------------------------------------------------

/** Wall-clock-as-UTC (rrule.js output space) -> the real UTC instant in `zone`. */
function wallClockToInstant(wallClock: Date, zone: string): Date {
  const zoned = new TZDate(
    wallClock.getUTCFullYear(),
    wallClock.getUTCMonth(),
    wallClock.getUTCDate(),
    wallClock.getUTCHours(),
    wallClock.getUTCMinutes(),
    wallClock.getUTCSeconds(),
    zone,
  )
  return new Date(zoned.getTime())
}

/** A real UTC instant -> wall-clock-as-UTC in `zone` (rrule.js input space). */
function instantToWallClock(instant: Date, zone: string): Date {
  const zoned = new TZDate(instant.getTime(), zone)
  return new Date(
    Date.UTC(
      zoned.getFullYear(),
      zoned.getMonth(),
      zoned.getDate(),
      zoned.getHours(),
      zoned.getMinutes(),
      zoned.getSeconds(),
    ),
  )
}

/** Render a real instant as the `YYYYMMDDTHHMMSS` local string RRule's DTSTART wants. */
function formatDtstart(instant: Date, zone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]))
  // Intl can render hour "24" at midnight in some engines; normalize to "00".
  const hour = parts.hour === "24" ? "00" : parts.hour
  return `${parts.year}${parts.month}${parts.day}T${hour}${parts.minute}${parts.second}`
}

function buildRuleSource(rule: string, startAt: Date, zone: string): string {
  return `DTSTART:${formatDtstart(startAt, zone)}\nRRULE:${rule.trim()}`
}

// ---------------------------------------------------------------------------
// The core: nextOccurrence — pure, deterministic, the only side-effect-free
// question the scheduler asks.
// ---------------------------------------------------------------------------

export interface NextOccurrenceOptions {
  /** Reference instant; the result is strictly after this. */
  after: Date
  /** IANA timezone the recurrence calendar is evaluated in. */
  timezone: string
  /** Recurrence anchor (DTSTART). The first occurrence is at/after this. */
  startAt: Date
}

/**
 * The next real-UTC instant the recurrence fires, strictly **after** `after`, or
 * `null` when the recurrence is exhausted (`UNTIL` / `COUNT` reached) or the rule
 * is unparseable.
 *
 * Pure and deterministic: identical `(rule, options)` always produce the same
 * `Date | null`. Throws nothing — a malformed rule yields `null` so callers
 * never have to wrap it.
 */
export function nextOccurrence(rule: string, options: NextOccurrenceOptions): Date | null {
  const trimmed = rule.trim()
  if (!trimmed) return null
  let parsed: RRule
  try {
    parsed = RRule.fromString(buildRuleSource(trimmed, options.startAt, options.timezone))
  } catch {
    return null
  }
  // `inc = false` => strictly after the reference.
  const next = parsed.after(instantToWallClock(options.after, options.timezone), false)
  return next ? wallClockToInstant(next, options.timezone) : null
}

/**
 * Up to `count` upcoming occurrences after a reference instant (for the create
 * form's preview). Walks {@link nextOccurrence} forward; stops early when the
 * recurrence is exhausted. Pure given its inputs.
 */
export function upcomingOccurrences(
  rule: string,
  options: NextOccurrenceOptions & { count: number },
): Date[] {
  const results: Date[] = []
  let cursor = options.after
  for (let i = 0; i < options.count; i++) {
    const next = nextOccurrence(rule, {
      after: cursor,
      timezone: options.timezone,
      startAt: options.startAt,
    })
    if (!next) break
    results.push(next)
    cursor = next
  }
  return results
}

/** True when `rule` parses as a usable RRULE (a `FREQ` is present and accepted). */
export function isValidRrule(rule: string): boolean {
  const trimmed = rule.trim()
  if (!trimmed) return false
  const parts = parseRruleParts(trimmed)
  if (!parts?.FREQ) return false
  try {
    RRule.fromString(`RRULE:${trimmed}`)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Schedule presets — the small set of shapes the create form's simple builder
// can author, plus a "custom" escape hatch for raw RRULE editing.
// ---------------------------------------------------------------------------

export type SchedulePreset =
  | { kind: "hourly" }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; day: Weekday; hour: number; minute: number }
  | { kind: "custom"; rule: string }

/** Build an RRULE body from a preset (the inverse of {@link matchPreset}). */
export function buildRrule(preset: SchedulePreset): string {
  switch (preset.kind) {
    case "hourly":
      return "FREQ=HOURLY"
    case "daily":
      return `FREQ=DAILY;BYHOUR=${preset.hour};BYMINUTE=${preset.minute}`
    case "weekdays":
      return `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=${preset.hour};BYMINUTE=${preset.minute}`
    case "weekly":
      return `FREQ=WEEKLY;BYDAY=${preset.day};BYHOUR=${preset.hour};BYMINUTE=${preset.minute}`
    case "custom":
      return preset.rule
  }
}

/**
 * Detect which preset an existing RRULE matches, so the create form can re-open
 * a saved automation in its simple builder. Anything outside the five authored
 * shapes (intervals, MONTHLY/YEARLY, bounds, etc.) collapses to `custom`.
 */
export function matchPreset(rule: string): SchedulePreset {
  const parts = parseRruleParts(rule)
  if (!parts) return { kind: "custom", rule }
  if (parts.BYSETPOS || parts.BYYEARDAY || parts.BYWEEKNO || parts.COUNT || parts.UNTIL) {
    return { kind: "custom", rule }
  }
  if ((parseInt10(parts.INTERVAL) ?? 1) !== 1) return { kind: "custom", rule }

  const freq = parts.FREQ
  const byHour = parseInt10(parts.BYHOUR)
  const byMinute = parseInt10(parts.BYMINUTE) ?? 0
  const byDay = parseDays(parts.BYDAY)

  if (freq === "HOURLY" && byHour === null && byDay.length === 0) return { kind: "hourly" }
  if (freq === "DAILY" && byHour !== null && byDay.length === 0) {
    return { kind: "daily", hour: byHour, minute: byMinute }
  }
  if (freq === "WEEKLY" && byHour !== null) {
    if (sameDays(byDay, WEEKDAYS)) return { kind: "weekdays", hour: byHour, minute: byMinute }
    if (byDay.length === 1) {
      return { kind: "weekly", day: byDay[0] as Weekday, hour: byHour, minute: byMinute }
    }
  }
  return { kind: "custom", rule }
}

// ---------------------------------------------------------------------------
// describeSchedule — short human-readable cadence for list rows / previews.
// ---------------------------------------------------------------------------

export interface DescribeOptions {
  /** BCP-47 locale for time formatting; defaults to the runtime locale. */
  locale?: string
}

/** "Weekdays at 9:00 AM", "Hourly", "Custom" — a one-line cadence summary. */
export function describeSchedule(rule: string, options: DescribeOptions = {}): string {
  const parts = parseRruleParts(rule)
  if (!parts) return "Custom"
  if (parts.BYSETPOS || parts.BYYEARDAY || parts.BYWEEKNO || parts.COUNT || parts.UNTIL) {
    return "Custom"
  }

  const interval = parseInt10(parts.INTERVAL) ?? 1
  const byHour = parseInt10(parts.BYHOUR)
  const byMinute = parseInt10(parts.BYMINUTE) ?? 0
  const byDay = parseDays(parts.BYDAY)
  const at = byHour !== null ? ` at ${formatTime(byHour, byMinute, options.locale)}` : ""

  switch (parts.FREQ) {
    case "MINUTELY":
      return interval === 1 ? "Every minute" : `Every ${interval} minutes`
    case "HOURLY":
      return interval === 1 ? "Hourly" : `Every ${interval} hours`
    case "DAILY":
      return interval === 1 ? `Daily${at}` : `Every ${interval} days${at}`
    case "WEEKLY": {
      if (interval !== 1) return "Custom"
      if (byDay.length === 0) return `Weekly${at}`
      if (sameDays(byDay, WEEKDAYS)) return `Weekdays${at}`
      if (sameDays(byDay, WEEKENDS)) return `Weekends${at}`
      if (byDay.length === 1) return `${DAY_PLURAL[byDay[0] as keyof typeof DAY_PLURAL]}${at}`
      return `${sortDays(byDay)
        .map((d) => DAY_SHORT[d])
        .join(", ")}${at}`
    }
    default:
      return "Custom"
  }
}

const DATETIME_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
}

/** Format a real UTC instant in a given timezone for display (run rows, previews). */
export function formatInstant(date: Date, timezone: string, options: DescribeOptions = {}): string {
  try {
    return new Intl.DateTimeFormat(options.locale, {
      ...DATETIME_FORMAT,
      timeZone: timezone,
    }).format(date)
  } catch {
    return new Intl.DateTimeFormat(options.locale, { ...DATETIME_FORMAT, timeZone: "UTC" }).format(
      date,
    )
  }
}

// ---------------------------------------------------------------------------
// Internal RRULE-string helpers (string-only, no rrule.js dep).
// ---------------------------------------------------------------------------

type RruleParts = Record<string, string>

function parseRruleParts(rule: string): RruleParts | null {
  const parts: RruleParts = {}
  for (const segment of rule.split(";")) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf("=")
    if (eq < 0) return null
    const key = trimmed.slice(0, eq).trim().toUpperCase()
    const value = trimmed.slice(eq + 1).trim()
    if (!key || !value) return null
    parts[key] = value
  }
  return parts.FREQ ? parts : null
}

function parseInt10(value: string | undefined): number | null {
  if (value === undefined) return null
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : null
}

function parseDays(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((d) => d.trim().toUpperCase())
    .filter((d) => d in DAY_PLURAL)
}

function sortDays(days: string[]): string[] {
  return [...days].sort((a, b) => DAY_ORDER.indexOf(a as never) - DAY_ORDER.indexOf(b as never))
}

function sameDays(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  return sortDays([...a]).join(",") === sortDays([...b]).join(",")
}

function formatTime(hour: number, minute: number, locale: string | undefined): string {
  // BYHOUR/BYMINUTE are wall-clock digits in the automation's own zone, so we
  // only need locale-appropriate hour:minute rendering (12h vs 24h).
  const ref = new Date(Date.UTC(2000, 0, 3, hour, minute))
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
  }).format(ref)
}
