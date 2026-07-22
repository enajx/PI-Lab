/**
 * Format an epoch-ms instant as a short, human "time ago" phrase for the
 * "Last checked: <relative time>" line in the workflow result popup. Uses
 * `Intl.RelativeTimeFormat` so it localizes, and steps through the natural units
 * (seconds → minutes → hours → days). Instants within a few seconds read as
 * "just now"; anything a week or more out falls back to an absolute date so the
 * phrasing never becomes "3 weeks ago"-vague for a stale check.
 */
export function formatRelativeTime(epochMs: number, now: number = Date.now()): string {
  const diffMs = epochMs - now
  const seconds = Math.round(diffMs / 1000)
  const absSeconds = Math.abs(seconds)
  if (absSeconds < 5) return "just now"

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
  if (absSeconds < 60) return rtf.format(seconds, "second")

  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute")

  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour")

  const days = Math.round(hours / 24)
  if (Math.abs(days) < 7) return rtf.format(days, "day")

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(epochMs))
}
