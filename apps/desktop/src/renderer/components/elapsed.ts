/** Time passed since a moment, in its largest whole unit; "now" is under a minute. */
export type Elapsed = { unit: "now" } | { unit: "minute" | "hour" | "day"; count: number }

/** How long ago `then` was at `now` (both in ms), rounded down to whole minutes, hours or days. */
export function elapsedSince(then: number, now: number): Elapsed {
  const minutes = Math.floor((now - then) / 60_000)
  if (minutes < 1) return { unit: "now" }
  if (minutes < 60) return { unit: "minute", count: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { unit: "hour", count: hours }
  return { unit: "day", count: Math.floor(hours / 24) }
}
