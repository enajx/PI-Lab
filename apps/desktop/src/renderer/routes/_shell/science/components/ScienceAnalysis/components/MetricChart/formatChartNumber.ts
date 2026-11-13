/** Magnitudes at or above this use scientific notation. */
const LARGE = 1e6
/** Non-zero magnitudes below this use scientific notation. */
const SMALL = 1e-3

/**
 * Format a chart value for ticks and the tooltip: integers as they are, other
 * numbers to 4 significant digits, and very small or large magnitudes in
 * scientific notation (`1.234e-6`, `3.2e+8`). Trailing zeros are dropped.
 */
export function formatChartNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  const magnitude = Math.abs(value)
  if (magnitude >= LARGE || (magnitude > 0 && magnitude < SMALL)) {
    const [mantissa = "", exponent = ""] = value.toExponential(3).split("e")
    return `${String(Number(mantissa))}e${exponent}`
  }
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toPrecision(4)))
}
