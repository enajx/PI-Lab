import { open } from "node:fs/promises"
import { TRPCError } from "@trpc/server"
import {
  type ChartAggregate,
  type ChartSpec,
  type ColumnInfo,
  type ColumnRole,
  formatCell,
  MAX_FRAME_ROWS,
  MAX_PLOT_POINTS,
  MAX_TABLE_ROWS,
  type PlotPreview,
  type PlotSeries,
  type TablePreview,
} from "./previewShapes"

/**
 * Tables read by every table format (CSV/TSV, Parquet, pickled DataFrames,
 * HDF5 compound datasets): a {@link Frame} of at most {@link MAX_FRAME_ROWS}
 * typed columns, what each column holds ({@link ColumnInfo}), whether the
 * table opens as a table or a chart, and the chart builder ({@link buildPlot}).
 */

/** One typed column of a {@link Frame}. */
export type FrameColumn =
  | { name: string; kind: "number"; values: Array<number | null> }
  | { name: string; kind: "bool"; values: Array<boolean | null> }
  | { name: string; kind: "text"; values: Array<string | null> }

/** The first rows of a table, read into typed columns. */
export interface Frame {
  columns: FrameColumn[]
  /** The first {@link MAX_TABLE_ROWS} rows as the table shows them. */
  head: string[][]
  /** Rows held in `columns`. */
  rowCount: number
  /** Rows in the file, or `rowCount` when `partial`. */
  totalRows: number
  /** True when the file has more rows than were read. */
  partial: boolean
  /** The column that is a pickled DataFrame's unnamed index, or null. */
  indexColumn: number | null
}

/** Share of non-empty cells that must be numbers for a text column to be numeric. */
const NUMERIC_SHARE = 0.8
/** Share of consecutive values that must increase for a column to be a step axis. */
const STEP_SHARE = 0.95
/** Integer columns with at most this many values are factors. */
const FACTOR_MAX_VALUES = 20
/** Integer columns whose values repeat this many times on average are factors. */
const FACTOR_MIN_REPEATS = 5
/** Text columns with more values than this are free text, not factors. */
const TEXT_FACTOR_MAX_VALUES = 50
/** Most split values drawn as their own series. */
const MAX_SPLIT_VALUES = 20
/** Most series in one chart. */
const MAX_SERIES = 40

const TRUE_TEXT = new Set(["true", "True", "TRUE"])
const FALSE_TEXT = new Set(["false", "False", "FALSE"])

/** A number from table text, or null for empty or non-numeric cells. */
function numberOf(cell: string | undefined): number | null {
  if (cell === undefined || cell.trim() === "") return null
  const value = Number(cell)
  return Number.isFinite(value) ? value : null
}

/** A frame from text cells (CSV/TSV): each column is read as True/False, numbers or text. */
export function frameFromText(
  headers: string[],
  rows: string[][],
  totalRows: number,
  partial: boolean,
): Frame {
  const columns = headers.map((name, col): FrameColumn => {
    const cells = rows.map((row) => row[col] ?? "")
    const filled = cells.filter((cell) => cell.trim() !== "")
    if (filled.length > 0 && filled.every((c) => TRUE_TEXT.has(c) || FALSE_TEXT.has(c))) {
      return {
        name,
        kind: "bool",
        values: cells.map((c) => (TRUE_TEXT.has(c) ? true : FALSE_TEXT.has(c) ? false : null)),
      }
    }
    const numbers = cells.map(numberOf)
    const numeric = numbers.filter((value) => value !== null).length
    if (filled.length > 0 && numeric / filled.length >= NUMERIC_SHARE) {
      return { name, kind: "number", values: numbers }
    }
    return { name, kind: "text", values: cells.map((c) => (c === "" ? null : c)) }
  })
  return {
    columns,
    head: rows.slice(0, MAX_TABLE_ROWS),
    rowCount: rows.length,
    totalRows,
    partial,
    indexColumn: null,
  }
}

/**
 * A frame from typed values (Parquet, pickles, HDF5), column by column. A
 * column of only numbers (or bigints) is numeric, of only booleans is
 * True/False, anything else is text via `text`. `head` is the shown rows.
 */
export function frameFromValues(args: {
  headers: string[]
  columns: unknown[][]
  head: string[][]
  totalRows: number
  indexColumn: number | null
  text: (value: unknown) => string
}): Frame {
  const { headers, columns, head, totalRows, indexColumn, text } = args
  const rowCount = columns[0]?.length ?? 0
  const typed = headers.map((name, col): FrameColumn => {
    const values = columns[col] ?? []
    const filled = values.filter((value) => value !== null && value !== undefined)
    if (filled.length > 0 && filled.every((v) => typeof v === "number" || typeof v === "bigint")) {
      return {
        name,
        kind: "number",
        values: values.map((v) => {
          const n = typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : null
          return n !== null && Number.isFinite(n) ? n : null
        }),
      }
    }
    if (filled.length > 0 && filled.every((v) => typeof v === "boolean")) {
      return { name, kind: "bool", values: values.map((v) => (typeof v === "boolean" ? v : null)) }
    }
    return {
      name,
      kind: "text",
      values: values.map((v) => (v === null || v === undefined ? null : text(v))),
    }
  })
  return {
    columns: typed,
    head,
    rowCount,
    totalRows: Math.max(totalRows, rowCount),
    partial: totalRows > rowCount,
    indexColumn,
  }
}

/** Distinct non-null values of a column, counted up to `limit + 1`. */
function distinctCount(values: ReadonlyArray<unknown>, limit: number): number {
  const seen = new Set<unknown>()
  for (const value of values) {
    if (value === null) continue
    seen.add(value)
    if (seen.size > limit) break
  }
  return seen.size
}

/** Whether a numeric column increases from row to row (a step axis). */
function isStep(values: ReadonlyArray<number | null>): boolean {
  let prev: number | null = null
  let pairs = 0
  let increasing = 0
  for (const value of values) {
    if (value === null) continue
    if (prev !== null) {
      pairs++
      if (value > prev) increasing++
    }
    prev = value
  }
  return pairs > 0 && increasing / pairs >= STEP_SHARE
}

/** A column's role; only the first numeric column (`mayBeStep`) can be the step. */
function roleOf(column: FrameColumn, isIndex: boolean, mayBeStep: boolean): ColumnRole {
  if (isIndex) return "index"
  if (column.kind === "bool") return "factor"
  if (column.kind === "text") {
    return distinctCount(column.values, TEXT_FACTOR_MAX_VALUES) > TEXT_FACTOR_MAX_VALUES
      ? "text"
      : "factor"
  }
  const values = column.values
  if (mayBeStep && isStep(values)) return "step"
  const filled = values.filter((value): value is number => value !== null)
  if (filled.length > 0 && filled.every(Number.isInteger)) {
    const distinct = distinctCount(filled, filled.length)
    if (distinct <= FACTOR_MAX_VALUES || filled.length / distinct >= FACTOR_MIN_REPEATS) {
      return "factor"
    }
  }
  return "measure"
}

/**
 * What each column of a frame holds. Only the first numeric column can be
 * the step axis, as in a metric log. In a metric log (a table with a step
 * column) every row is a time point, so a numeric column that changes is a
 * measure; only constant ones (e.g. `seed`) stay factors.
 */
export function describeColumns(frame: Frame): ColumnInfo[] {
  const firstNumeric = frame.columns.findIndex(
    (column, col) => column.kind === "number" && col !== frame.indexColumn,
  )
  const columns = frame.columns.map(
    (column, col): ColumnInfo => ({
      name: column.name,
      kind: column.kind,
      role: roleOf(column, col === frame.indexColumn, col === firstNumeric),
    }),
  )
  const stepTaken = columns.some((info) => info.role === "step")
  if (!stepTaken) return columns
  return columns.map((info, col) => {
    const values = frame.columns[col]?.values ?? []
    return info.kind === "number" && info.role === "factor" && distinctCount(values, 1) > 1
      ? { ...info, role: "measure" }
      : info
  })
}

/** Whether a column has any value twice. */
function hasRepeats(column: FrameColumn): boolean {
  const seen = new Set<unknown>()
  for (const value of column.values) {
    if (value === null) continue
    if (seen.has(value)) return true
    seen.add(value)
  }
  return false
}

/**
 * The chart shown first: a step column against every measure (a metric log),
 * else the first numeric factor (e.g. `question`) against the first measure,
 * averaged when x repeats. Null when nothing can be plotted.
 */
function defaultSpecOf(frame: Frame, columns: ColumnInfo[]): ChartSpec | null {
  const step = columns.find((c) => c.role === "step")
  const x =
    step ??
    columns.find((c) => c.role === "factor" && c.kind === "number") ??
    columns.find((c) => c.kind === "number" && c.role !== "index") ??
    columns.find((c) => c.role === "factor")
  if (!x) return null
  const measures = columns.filter((c) => c.role === "measure" && c.name !== x.name)
  const y = step
    ? measures
    : [
        measures[0] ??
          columns.find((c) => c.kind === "bool") ??
          columns.find((c) => c.kind === "number" && c.name !== x.name && c.role !== "index"),
      ].filter((c): c is ColumnInfo => c !== undefined)
  if (y.length === 0) return null
  const xColumn = frame.columns.find((c) => c.name === x.name)
  return {
    x: x.name,
    y: y.map((c) => c.name),
    splitBy: null,
    chartType: "line",
    aggregate: xColumn && hasRepeats(xColumn) ? "mean" : "none",
    band: "none",
  }
}

/** The table preview of a frame: its first rows, column roles, and default view. */
export function tableFromFrame(frame: Frame): TablePreview {
  const columns = describeColumns(frame)
  const hasStep = columns.some((c) => c.role === "step")
  const hasMeasure = columns.some((c) => c.role === "measure")
  return {
    type: "table",
    headers: frame.columns.map((c) => c.name),
    rows: frame.head,
    totalRows: frame.totalRows,
    truncated: frame.totalRows > frame.head.length,
    partial: frame.partial,
    columns,
    defaultView: hasStep && hasMeasure ? "chart" : "table",
    defaultSpec: defaultSpecOf(frame, columns),
  }
}

// ── Chart builder ────────────────────────────────────────────────────────────

function columnNamed(frame: Frame, name: string): FrameColumn {
  const column = frame.columns.find((c) => c.name === name)
  if (!column)
    throw new TRPCError({ code: "BAD_REQUEST", message: `No column "${name}" in this file` })
  return column
}

/** A cell as a number for the y axis: True/False as 1/0, text not at all. */
function yValue(column: FrameColumn, row: number): number | null {
  const value = column.values[row]
  if (value === null || value === undefined) return null
  if (typeof value === "boolean") return value ? 1 : 0
  return typeof value === "number" ? value : null
}

/** A cell as split text: one series per distinct value. */
function splitText(value: number | boolean | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === "number") return formatCell(value)
  if (typeof value === "boolean") return value ? "True" : "False"
  return value
}

/** x values of a column: numbers as is, True/False as 1/0, text as category indexes. */
function xValues(column: FrameColumn): { x: Array<number | null>; categories: string[] | null } {
  if (column.kind === "text") {
    const index = new Map<string, number>()
    const x = column.values.map((value) => {
      if (value === null) return null
      let at = index.get(value)
      if (at === undefined) {
        at = index.size
        index.set(value, at)
      }
      return at
    })
    return { x, categories: [...index.keys()] }
  }
  if (column.kind === "bool") {
    return { x: column.values.map((v) => (v === null ? null : v ? 1 : 0)), categories: null }
  }
  return { x: column.values, categories: null }
}

function aggregateOf(values: number[], aggregate: Exclude<ChartAggregate, "none">): number {
  if (aggregate === "count") return values.length
  const sum = values.reduce((total, value) => total + value, 0)
  if (aggregate === "sum") return sum
  if (aggregate === "mean") return sum / values.length
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** Sample standard deviation (0 for one value). */
function stdOf(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  const squares = values.reduce((total, value) => total + (value - mean) ** 2, 0)
  return Math.sqrt(squares / (values.length - 1))
}

/** One series from its (x, y) points, aggregated per x when asked. */
function seriesOf(
  label: string,
  points: Array<[number, number | null]>,
  spec: ChartSpec,
): PlotSeries {
  if (spec.aggregate === "none") {
    const ordered = spec.chartType === "scatter" ? points : [...points].sort((a, b) => a[0] - b[0])
    return { label, x: ordered.map((p) => p[0]), y: ordered.map((p) => p[1]), lo: null, hi: null }
  }
  const byX = new Map<number, number[]>()
  for (const [x, y] of points) {
    if (y === null) continue
    const values = byX.get(x)
    if (values) values.push(y)
    else byX.set(x, [y])
  }
  const xs = [...byX.keys()].sort((a, b) => a - b)
  const y = xs.map((x) =>
    aggregateOf(byX.get(x) ?? [], spec.aggregate as Exclude<ChartAggregate, "none">),
  )
  const banded = spec.band !== "none" && (spec.aggregate === "mean" || spec.aggregate === "median")
  if (!banded) return { label, x: xs, y, lo: null, hi: null }
  const lo: number[] = []
  const hi: number[] = []
  xs.forEach((x, i) => {
    const values = byX.get(x) ?? []
    const center = y[i] ?? 0
    if (spec.band === "minmax") {
      lo.push(Math.min(...values))
      hi.push(Math.max(...values))
      return
    }
    const sd = stdOf(values)
    const half = spec.band === "std" ? sd : (1.96 * sd) / Math.sqrt(values.length)
    lo.push(center - half)
    hi.push(center + half)
  })
  return { label, x: xs, y, lo, hi }
}

/** Stride a series down to {@link MAX_PLOT_POINTS}; true when it was. */
function strideSeries(series: PlotSeries): { series: PlotSeries; strided: boolean } {
  if (series.x.length <= MAX_PLOT_POINTS) return { series, strided: false }
  const stride = Math.ceil(series.x.length / MAX_PLOT_POINTS)
  const keep = <T>(values: T[]): T[] => values.filter((_, i) => i % stride === 0)
  return {
    series: {
      label: series.label,
      x: keep(series.x),
      y: keep(series.y),
      lo: series.lo ? keep(series.lo) : null,
      hi: series.hi ? keep(series.hi) : null,
    },
    strided: true,
  }
}

/**
 * Plot a frame with a chart spec: x against each y column, one series per y
 * (and per split value), aggregated per x value when asked. An unknown or
 * text y column is a BAD_REQUEST naming it.
 */
export function buildPlot(frame: Frame, spec: ChartSpec): PlotPreview {
  const xColumn = columnNamed(frame, spec.x)
  const yColumns = spec.y.map((name) => {
    const column = columnNamed(frame, name)
    if (column.kind === "text") {
      throw new TRPCError({ code: "BAD_REQUEST", message: `Column "${name}" is not numeric` })
    }
    return column
  })
  const splitColumn = spec.splitBy === null ? null : columnNamed(frame, spec.splitBy)
  const notes: string[] = []
  const { x, categories } = xValues(xColumn)

  // Split values in order of first appearance, at most MAX_SPLIT_VALUES.
  const splitOf: Array<string | null> = []
  const splitValues: string[] = []
  if (splitColumn) {
    let dropped = 0
    const known = new Set<string>()
    for (let row = 0; row < frame.rowCount; row++) {
      const value = splitText(splitColumn.values[row])
      if (value !== null && !known.has(value)) {
        known.add(value)
        if (splitValues.length < MAX_SPLIT_VALUES) splitValues.push(value)
        else dropped++
      }
      splitOf.push(value)
    }
    if (dropped > 0) {
      notes.push(
        `${splitColumn.name} has ${known.size} values; the first ${MAX_SPLIT_VALUES} are drawn.`,
      )
    }
  }

  const groups: Array<{ label: string; y: FrameColumn; split: string | null }> = []
  for (const y of yColumns) {
    if (!splitColumn) groups.push({ label: y.name, y, split: null })
    for (const value of splitValues) {
      const name = `${splitColumn?.name}=${value}`
      groups.push({ label: yColumns.length > 1 ? `${y.name} · ${name}` : name, y, split: value })
    }
  }
  if (groups.length > MAX_SERIES) {
    notes.push(`The settings make ${groups.length} series; the first ${MAX_SERIES} are drawn.`)
    groups.length = MAX_SERIES
  }
  if (spec.band !== "none" && spec.aggregate !== "mean" && spec.aggregate !== "median") {
    notes.push("The spread band needs mean or median aggregation.")
  }

  let downsampled = false
  const series = groups.map((group) => {
    // A blank y stays as a gap in the line; a blank x leaves the row out.
    const points: Array<[number, number | null]> = []
    for (let row = 0; row < frame.rowCount; row++) {
      if (group.split !== null && splitOf[row] !== group.split) continue
      const xValue = x[row]
      if (xValue === null || xValue === undefined) continue
      points.push([xValue, yValue(group.y, row)])
    }
    const strided = strideSeries(seriesOf(group.label, points, spec))
    if (strided.strided) downsampled = true
    return strided.series
  })

  return {
    type: "plot",
    chartType: spec.chartType,
    xLabel: xColumn.name,
    xCategories: categories,
    series,
    rowsUsed: frame.rowCount,
    partial: frame.partial,
    downsampled,
    notes,
  }
}

// ── CSV/TSV ──────────────────────────────────────────────────────────────────

/**
 * Read a CSV/TSV into a frame: at most `maxBytes` and {@link MAX_FRAME_ROWS}
 * rows. A row cut by the byte limit is dropped. Quoted fields may hold the
 * delimiter but not line breaks.
 */
export async function readDelimitedFrame(
  abs: string,
  delimiter: string,
  maxBytes: number,
): Promise<Frame | null> {
  const file = await open(abs, "r")
  let text: string
  let bytesCut: boolean
  try {
    const { size } = await file.stat()
    const buf = Buffer.allocUnsafe(Math.min(size, maxBytes) + 1)
    let bytesRead = 0
    while (bytesRead < buf.length) {
      const { bytesRead: n } = await file.read(buf, bytesRead, buf.length - bytesRead, bytesRead)
      if (n === 0) break
      bytesRead += n
    }
    bytesCut = bytesRead > maxBytes
    text = buf.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8")
  } finally {
    await file.close()
  }
  const lines = text.split(/\r?\n/)
  if (bytesCut) lines.pop()
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  if (lines.length === 0) return null
  const headers = parseDelimited(lines[0] ?? "", delimiter)
  const body = lines.slice(1)
  const rowsCut = body.length > MAX_FRAME_ROWS
  const rows = body.slice(0, MAX_FRAME_ROWS).map((line) => parseDelimited(line, delimiter))
  const partial = bytesCut || rowsCut
  return frameFromText(headers, rows, partial ? rows.length : body.length, partial)
}

/** Split one CSV/TSV line into fields, honouring double quotes. */
export function parseDelimited(line: string, delimiter: string): string[] {
  const fields: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      fields.push(field)
      field = ""
    } else {
      field += ch
    }
  }
  fields.push(field)
  return fields
}
