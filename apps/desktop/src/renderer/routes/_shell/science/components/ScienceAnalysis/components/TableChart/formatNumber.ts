/** How numbers in a table are shown (Table settings > Number format). */
export interface NumberFormat {
  /** Decimal places, or null for up to 6 significant digits. */
  decimals: number | null
  /** Scientific notation, e.g. 1.23e-4. */
  scientific: boolean
}

/**
 * A numeric table cell as text in `format`. Cells that are not numbers (blank,
 * `nan`) are returned unchanged.
 */
export function formatNumber(text: string, format: NumberFormat): string {
  if (text.trim() === "") return text
  const value = Number(text)
  if (!Number.isFinite(value)) return text
  if (format.scientific) {
    return format.decimals === null
      ? value.toExponential().replace(/(\.\d{5})\d+e/, "$1e")
      : value.toExponential(format.decimals)
  }
  if (format.decimals !== null) return value.toFixed(format.decimals)
  return String(Number(value.toPrecision(6)))
}
