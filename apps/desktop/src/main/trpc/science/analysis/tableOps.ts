import { TRPCError } from "@trpc/server"
import type { AggFunction, Aggregation, RowFilter, TableOps, TablePage } from "./previewShapes"
import {
  defaultSpecOf,
  describeColumns,
  type Frame,
  type FrameColumn,
  frameFromValues,
} from "./tables"

/**
 * Table operations in a fixed order: row filters, then one optional
 * aggregation (group by, pivot, describe, value counts), then the sort. They
 * run on a {@link Frame} (the first rows read from a file) and give a new
 * frame, which the table pages through, the chart builder plots and the CSV
 * export writes. The file is never changed.
 */

type Cell = number | boolean | string | null

/** Most pivot columns; more values of the columns field are left out with a note. */
const MAX_PIVOT_COLUMNS = 100

/** A frame after its operations, with notes for the user. */
export interface OpsResult {
  frame: Frame
  notes: string[]
}

function badRequest(message: string): TRPCError {
  return new TRPCError({ code: "BAD_REQUEST", message })
}

function columnOf(frame: Frame, name: string): FrameColumn {
  const column = frame.columns.find((c) => c.name === name)
  if (!column) throw badRequest(`No column "${name}" in this table`)
  return column
}

function cellAt(column: FrameColumn, row: number): Cell {
  return column.values[row] ?? null
}

/** A cell as text: numbers with up to 12 significant digits (no float noise), True/False. */
export function cellString(value: Cell): string {
  if (value === null) return ""
  if (typeof value === "number") return String(Number(value.toPrecision(12)))
  if (typeof value === "boolean") return value ? "True" : "False"
  return value
}

/** Order of two cells: numbers by value, False before True, text by code point; blanks last. */
function compareCells(a: Cell, b: Cell): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  if (typeof a === "number" && typeof b === "number") return a - b
  if (typeof a === "boolean" && typeof b === "boolean") return a ? 1 : -1
  const sa = cellString(a)
  const sb = cellString(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

/** A key that tells cells apart by type and value, for grouping. */
function keyOf(value: Cell): string {
  return `${typeof value}:${cellString(value)}`
}

// ── Filters ──────────────────────────────────────────────────────────────────

function needNumber(filter: RowFilter): number {
  const value = Number(filter.value)
  if (filter.value.trim() === "" || !Number.isFinite(value)) {
    throw badRequest(`The filter on "${filter.column}" needs a number, not "${filter.value}"`)
  }
  return value
}

/** Whether a cell equals typed text: as a number on numeric columns, True/False ignoring case. */
function matches(column: FrameColumn, value: Cell, text: string): boolean {
  if (value === null) return false
  const typed = text.trim()
  if (column.kind === "number") {
    const number = Number(typed)
    return typed !== "" && Number.isFinite(number) ? value === number : cellString(value) === typed
  }
  if (column.kind === "bool") return cellString(value).toLowerCase() === typed.toLowerCase()
  return cellString(value) === text
}

/** Whether a filter has what it needs to apply; one with no value yet keeps every row. */
function isComplete(filter: RowFilter): boolean {
  if (filter.op === "blank" || filter.op === "notBlank") return true
  if (filter.op === "in") return filter.values.length > 0
  return filter.value.trim() !== ""
}

/** Whether one cell passes one (complete) filter. */
function passes(column: FrameColumn, value: Cell, filter: RowFilter): boolean {
  switch (filter.op) {
    case "blank":
      return value === null
    case "notBlank":
      return value !== null
    case "in":
      return filter.values.some((text) => matches(column, value, text))
    case "contains":
      return value !== null && cellString(value).toLowerCase().includes(filter.value.toLowerCase())
    case "eq":
      return matches(column, value, filter.value)
    case "ne":
      return !matches(column, value, filter.value)
    default: {
      const limit = needNumber(filter)
      if (typeof value !== "number") return false
      if (filter.op === "lt") return value < limit
      if (filter.op === "le") return value <= limit
      if (filter.op === "gt") return value > limit
      return value >= limit
    }
  }
}

/** Row indexes that pass every filter. */
function filteredRows(frame: Frame, filters: RowFilter[]): number[] {
  const checks = filters
    .filter(isComplete)
    .map((filter) => ({ filter, column: columnOf(frame, filter.column) }))
  const rows: number[] = []
  for (let row = 0; row < frame.rowCount; row++) {
    if (checks.every(({ filter, column }) => passes(column, cellAt(column, row), filter))) {
      rows.push(row)
    }
  }
  return rows
}

/** A frame of the given rows of `frame`, keeping each column's kind. */
function takeRows(frame: Frame, rows: number[]): Frame {
  return {
    ...frame,
    columns: frame.columns.map(
      (column) =>
        ({
          name: column.name,
          kind: column.kind,
          values: rows.map((row) => column.values[row] ?? null),
        }) as FrameColumn,
    ),
    head: [],
    rowCount: rows.length,
    totalRows: rows.length,
  }
}

/** A frame built from computed columns; each column's kind is read from its values. */
function frameOf(headers: string[], columns: Cell[][], partial: boolean): Frame {
  const frame = frameFromValues({
    headers,
    columns,
    head: [],
    totalRows: columns[0]?.length ?? 0,
    indexColumn: null,
    text: (value) => String(value),
  })
  return { ...frame, partial }
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/** Linear-interpolated quantile of sorted numbers (as pandas does). */
function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null
  const at = (sorted.length - 1) * q
  const low = Math.floor(at)
  const high = Math.ceil(at)
  const a = sorted[low] ?? 0
  const b = sorted[high] ?? 0
  return a + (b - a) * (at - low)
}

function stdOf(values: number[]): number | null {
  if (values.length < 2) return null
  const mean = values.reduce((t, v) => t + v, 0) / values.length
  return Math.sqrt(values.reduce((t, v) => t + (v - mean) ** 2, 0) / (values.length - 1))
}

/** The numbers of a column's cells (True/False as 1/0); text is an error naming the column. */
function numbersOf(column: FrameColumn, cells: Cell[], fn: AggFunction): number[] {
  if (column.kind === "text") {
    throw badRequest(`"${fn}" needs a numeric column; "${column.name}" holds text`)
  }
  return cells
    .filter((cell): cell is number | boolean => cell !== null)
    .map((cell) => (typeof cell === "boolean" ? (cell ? 1 : 0) : (cell as number)))
}

/** Combine the cells of one group with `fn`. */
function aggregate(column: FrameColumn, cells: Cell[], fn: AggFunction): Cell {
  const filled = cells.filter((cell) => cell !== null)
  if (fn === "count") return filled.length
  if (fn === "nunique") return new Set(filled.map(keyOf)).size
  if (fn === "first") return filled[0] ?? null
  if (fn === "last") return filled[filled.length - 1] ?? null
  const numbers = numbersOf(column, cells, fn)
  if (fn === "sum") return numbers.reduce((t, v) => t + v, 0)
  if (numbers.length === 0) return null
  if (fn === "mean") return numbers.reduce((t, v) => t + v, 0) / numbers.length
  if (fn === "min") return Math.min(...numbers)
  if (fn === "max") return Math.max(...numbers)
  if (fn === "median")
    return quantile(
      [...numbers].sort((a, b) => a - b),
      0.5,
    )
  const std = stdOf(numbers)
  if (fn === "std" || std === null) return std
  return std / Math.sqrt(numbers.length)
}

/** Groups of rows by the values of `by` (rows with a blank key are left out), in key order. */
function groupRows(rows: number[], by: FrameColumn[]): Array<{ key: Cell[]; rows: number[] }> {
  const groups = new Map<string, { key: Cell[]; rows: number[] }>()
  for (const row of rows) {
    const key = by.map((column) => cellAt(column, row))
    if (key.some((cell) => cell === null)) continue
    const id = key.map(keyOf).join("\u0000")
    const group = groups.get(id)
    if (group) group.rows.push(row)
    else groups.set(id, { key, rows: [row] })
  }
  return [...groups.values()].sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) {
      const order = compareCells(a.key[i] ?? null, b.key[i] ?? null)
      if (order !== 0) return order
    }
    return 0
  })
}

function groupBy(
  frame: Frame,
  rows: number[],
  spec: Extract<Aggregation, { kind: "groupBy" }>,
): Frame {
  if (spec.by.length === 0) throw badRequest("Group by needs at least one column")
  const by = spec.by.map((name) => columnOf(frame, name))
  const values = spec.values.map((v) => ({ ...v, column: columnOf(frame, v.column) }))
  const groups = groupRows(rows, by)
  // With no value columns, the rows per group are counted (pandas `size()`), so there is always a result to show.
  if (values.length === 0) {
    const columns: Cell[][] = [...spec.by.map(() => [] as Cell[]), []]
    for (const group of groups) {
      group.key.forEach((cell, i) => {
        columns[i]?.push(cell)
      })
      columns[by.length]?.push(group.rows.length)
    }
    return frameOf([...spec.by, "count"], columns, frame.partial)
  }
  const headers = [...spec.by, ...spec.values.map((v) => `${v.column} (${v.fn})`)]
  const columns: Cell[][] = headers.map(() => [])
  for (const group of groups) {
    group.key.forEach((cell, i) => {
      columns[i]?.push(cell)
    })
    values.forEach((v, i) => {
      const cells = group.rows.map((row) => cellAt(v.column, row))
      columns[by.length + i]?.push(aggregate(v.column, cells, v.fn))
    })
  }
  return frameOf(headers, columns, frame.partial)
}

function pivot(
  frame: Frame,
  rows: number[],
  spec: Extract<Aggregation, { kind: "pivot" }>,
  notes: string[],
): Frame {
  const index = columnOf(frame, spec.index)
  const across = columnOf(frame, spec.columns)
  const values = columnOf(frame, spec.values)
  const rowGroups = groupRows(rows, [index])
  let columnKeys = groupRows(rows, [across]).map((group) => group.key[0] ?? null)
  if (columnKeys.length > MAX_PIVOT_COLUMNS) {
    notes.push(
      `${spec.columns} has ${columnKeys.length} values; the first ${MAX_PIVOT_COLUMNS} are columns.`,
    )
    columnKeys = columnKeys.slice(0, MAX_PIVOT_COLUMNS)
  }
  const headers = [spec.index, ...columnKeys.map(cellString)]
  const columns: Cell[][] = headers.map(() => [])
  for (const group of rowGroups) {
    columns[0]?.push(group.key[0] ?? null)
    columnKeys.forEach((key, i) => {
      const cells = group.rows
        .filter((row) => keyOf(cellAt(across, row)) === keyOf(key))
        .map((row) => cellAt(values, row))
      columns[i + 1]?.push(cells.length === 0 ? null : aggregate(values, cells, spec.fn))
    })
  }
  return frameOf(headers, columns, frame.partial)
}

const DESCRIBE_STATS = [
  "count",
  "unique",
  "top",
  "freq",
  "mean",
  "std",
  "min",
  "25%",
  "50%",
  "75%",
  "max",
] as const

/** Statistics per column (pandas `describe(include="all")`): numbers get mean to max, others unique, top, freq. */
function describe(frame: Frame, rows: number[]): Frame {
  const headers = ["statistic", ...frame.columns.map((c) => c.name)]
  const columns: Cell[][] = [[...DESCRIBE_STATS]]
  for (const column of frame.columns) {
    const cells = rows.map((row) => cellAt(column, row)).filter((cell) => cell !== null)
    const stats: Record<(typeof DESCRIBE_STATS)[number], Cell> = {
      count: cells.length,
      unique: null,
      top: null,
      freq: null,
      mean: null,
      std: null,
      min: null,
      "25%": null,
      "50%": null,
      "75%": null,
      max: null,
    }
    if (column.kind === "number") {
      const sorted = (cells as number[]).slice().sort((a, b) => a - b)
      stats.mean = sorted.length === 0 ? null : sorted.reduce((t, v) => t + v, 0) / sorted.length
      stats.std = stdOf(sorted)
      stats.min = sorted[0] ?? null
      stats["25%"] = quantile(sorted, 0.25)
      stats["50%"] = quantile(sorted, 0.5)
      stats["75%"] = quantile(sorted, 0.75)
      stats.max = sorted[sorted.length - 1] ?? null
    } else {
      const counts = new Map<string, { cell: Cell; count: number }>()
      for (const cell of cells) {
        const entry = counts.get(keyOf(cell))
        if (entry) entry.count++
        else counts.set(keyOf(cell), { cell, count: 1 })
      }
      let top: { cell: Cell; count: number } | null = null
      for (const entry of counts.values()) if (!top || entry.count > top.count) top = entry
      stats.unique = counts.size
      stats.top = top ? cellString(top.cell) : null
      stats.freq = top?.count ?? null
    }
    columns.push(DESCRIBE_STATS.map((stat) => stats[stat]))
  }
  return frameOf(headers, columns, frame.partial)
}

function valueCounts(
  frame: Frame,
  rows: number[],
  spec: Extract<Aggregation, { kind: "valueCounts" }>,
): Frame {
  if (spec.columns.length === 0) throw badRequest("Value counts needs at least one column")
  const by = spec.columns.map((name) => columnOf(frame, name))
  // Most frequent first; equal counts keep the key order.
  const groups = groupRows(rows, by).sort((a, b) => b.rows.length - a.rows.length)
  const headers = [...spec.columns, "count"]
  const columns: Cell[][] = headers.map(() => [])
  for (const group of groups) {
    group.key.forEach((cell, i) => {
      columns[i]?.push(cell)
    })
    columns[by.length]?.push(group.rows.length)
  }
  return frameOf(headers, columns, frame.partial)
}

// ── All together ─────────────────────────────────────────────────────────────

/** Apply filters, then the aggregation, then the sort. */
export function applyOps(frame: Frame, ops: TableOps): OpsResult {
  const notes: string[] = []
  const rows = filteredRows(frame, ops.filters)
  const aggregation = ops.aggregation
  let result: Frame
  if (aggregation === null) result = takeRows(frame, rows)
  else if (aggregation.kind === "groupBy") result = groupBy(frame, rows, aggregation)
  else if (aggregation.kind === "pivot") result = pivot(frame, rows, aggregation, notes)
  else if (aggregation.kind === "describe") result = describe(frame, rows)
  else result = valueCounts(frame, rows, aggregation)

  if (ops.sort.length > 0) {
    const keys = ops.sort.map((key) => ({ ...key, column: columnOf(result, key.column) }))
    const order = Array.from({ length: result.rowCount }, (_, row) => row)
    order.sort((a, b) => {
      for (const key of keys) {
        const left = cellAt(key.column, a)
        const right = cellAt(key.column, b)
        // Blanks stay last in both directions.
        if (left === null || right === null) {
          if (left === right) continue
          return left === null ? 1 : -1
        }
        const diff = compareCells(left, right)
        if (diff !== 0) return key.descending ? -diff : diff
      }
      return a - b
    })
    result = takeRows(result, order)
  }
  return { frame: result, notes }
}

/** Rows `offset` to `offset + limit` of a result, as a {@link TablePage}. */
export function pageOf(result: OpsResult, offset: number, limit: number): TablePage {
  const { frame } = result
  const end = Math.min(frame.rowCount, offset + limit)
  const rows: string[][] = []
  for (let row = offset; row < end; row++) {
    rows.push(frame.columns.map((column) => cellString(cellAt(column, row))))
  }
  const columns = describeColumns(frame)
  return {
    headers: frame.columns.map((c) => c.name),
    columns,
    defaultSpec: defaultSpecOf(frame, columns),
    rows,
    offset,
    totalRows: frame.rowCount,
    partial: frame.partial,
    notes: result.notes,
  }
}

function csvField(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * A result as CSV text: a header line, then one line per row, with the
 * `columns` named (in that order), or every column when null.
 */
export function csvOf(frame: Frame, columns: string[] | null): string {
  const shown = columns === null ? frame.columns : columns.map((name) => columnOf(frame, name))
  const lines = [shown.map((c) => csvField(c.name)).join(",")]
  for (let row = 0; row < frame.rowCount; row++) {
    lines.push(shown.map((column) => csvField(cellString(cellAt(column, row)))).join(","))
  }
  return `${lines.join("\n")}\n`
}
