import {
  describeClass,
  NdArray,
  PdFrame,
  type PdIndex,
  PdSeries,
  PickleFormatError,
  PickleRefusedError,
  PyBytes,
  PyDict,
  PyGlobal,
  PyOpaque,
  PySet,
  PySlice,
  PyTuple,
  type PyValue,
  unpickle,
} from "./pickle"
import {
  type ArrayPreview,
  type DataFilePreview,
  downsampleChart,
  formatCell,
  MAX_ARRAY_COLS,
  MAX_ARRAY_ROWS,
  MAX_TABLE_ROWS,
  MAX_TEXT_BYTES,
  type MetadataPreview,
} from "./previewShapes"

/**
 * Turn a pickle (a `.pkl` file or the payload of an object `.npy`) into a
 * preview: NumPy arrays become a chart or grid, pandas DataFrames a table,
 * Series a chart or table, and other plain data pretty-printed JSON. A refused
 * class or a malformed pickle becomes a metadata card that says why.
 */
export function previewPickle(
  data: Uint8Array,
  label: string,
  meta: (note?: string) => MetadataPreview,
): DataFilePreview {
  try {
    // Values are read lazily, so building the preview can also find bad data.
    return previewValue(unpickle(data), label, meta)
  } catch (error: unknown) {
    // The reader's own errors become a note on the card; anything else is a bug.
    if (error instanceof PickleRefusedError) return meta(error.message)
    if (error instanceof PickleFormatError)
      return meta(`Could not read the pickle: ${error.message}`)
    throw error
  }
}

/** Preview one unpickled value. */
export function previewValue(
  value: PyValue,
  label: string,
  meta: (note?: string) => MetadataPreview,
): DataFilePreview {
  if (value === null) return meta("Stores Python objects; the value is None")
  if (value instanceof NdArray) return previewArray(value, label, meta)
  if (value instanceof PdFrame) return previewFrame(value)
  if (value instanceof PdSeries) return previewSeries(value, label)
  if (Array.isArray(value) || value instanceof PyTuple) {
    const items = Array.isArray(value) ? value : value.items
    const sequence = previewSequence(items, label, meta)
    if (sequence) return sequence
  }
  return { type: "json", text: boundedJson(value) }
}

/** A 1-D/2-D array as a chart or grid; object arrays by what they hold. */
function previewArray(
  array: NdArray,
  label: string,
  meta: (note?: string) => MetadataPreview,
): DataFilePreview {
  const count = array.length
  if (array.objects?.every((item) => item === null)) {
    return meta(`Stores Python objects; all ${count} values are None`)
  }
  if (array.shape.length === 0) return { type: "json", text: boundedJson(array.at(0)) }
  if (array.shape.length > 2) {
    return meta(`Array of shape (${array.shape.join(", ")}); Analysis shows 1-D and 2-D arrays`)
  }
  const [rows = 0, cols = 1] = array.shape
  if (array.shape.length === 1 && isNumericList(array, count)) {
    return chartOf(label, count, (i) => array.at(i))
  }
  return grid(array.dtype?.descr ?? "|O", array.shape, rows, cols, (r, c) => array.at(r * cols + c))
}

/** A list of numbers is a chart; a list of same-shaped dicts is a table. */
function previewSequence(
  items: PyValue[],
  label: string,
  meta: (note?: string) => MetadataPreview,
): DataFilePreview | null {
  if (items.length > 0 && items.every((item) => item === null)) {
    return meta(`Stores Python objects; all ${items.length} values are None`)
  }
  if (items.length > 1 && items.every((item) => item === null || typeof item === "number")) {
    return chartOf(label, items.length, (i) => items[i] ?? null)
  }
  const first = items[0]
  if (first instanceof PyDict && items.every((item) => item instanceof PyDict)) {
    const headers = first.entries.map(([key]) => cellText(key))
    const rows = items
      .slice(0, MAX_TABLE_ROWS)
      .map((item) => (item instanceof PyDict ? item.entries.map(([, v]) => cellText(v)) : []))
    return {
      type: "table",
      headers,
      rows,
      totalRows: items.length,
      truncated: items.length > MAX_TABLE_ROWS,
    }
  }
  return null
}

/** A DataFrame as a table: the index first, then each column. */
function previewFrame(frame: PdFrame): DataFilePreview {
  const index = frame.index
  const length = index?.length ?? 0
  const shown = Math.min(length, MAX_TABLE_ROWS)
  const headers = [indexName(index?.name ?? null), ...frame.columns.map((c) => cellText(c.label))]
  const rows: string[][] = []
  for (let row = 0; row < shown; row++) {
    rows.push([
      cellText(index?.at(row) ?? null),
      ...frame.columns.map((column) => cellText(column.at(row))),
    ])
  }
  return { type: "table", headers, rows, totalRows: length, truncated: length > MAX_TABLE_ROWS }
}

/** A numeric Series as a chart over its index (when numeric), else a table. */
function previewSeries(series: PdSeries, label: string): DataFilePreview {
  const values = series.values
  const index = series.index
  if (!values || !index) return { type: "json", text: "null" }
  const name = series.name === null ? label : cellText(series.name)
  const length = values.length
  const numeric = Array.from({ length: Math.min(length, 1000) }, (_, i) => values.at(i)).every(
    (value) => value === null || typeof value === "number",
  )
  if (numeric && length > 1) {
    const xNumeric = isNumericIndex(index)
    const xAll: number[] = []
    const yAll: Array<number | null> = []
    for (let i = 0; i < length; i++) {
      const x = xNumeric ? index.at(i) : i
      xAll.push(typeof x === "number" ? x : i)
      const y = values.at(i)
      yAll.push(typeof y === "number" && Number.isFinite(y) ? y : null)
    }
    return downsampleChart(indexName(index.name) || "index", xAll, [name], [yAll])
  }
  const shown = Math.min(length, MAX_TABLE_ROWS)
  const rows: string[][] = []
  for (let row = 0; row < shown; row++) {
    rows.push([cellText(index.at(row)), cellText(values.at(row))])
  }
  return {
    type: "table",
    headers: [indexName(index.name), name],
    rows,
    totalRows: length,
    truncated: length > MAX_TABLE_ROWS,
  }
}

/** An index's name as a header: empty when it has none. */
function indexName(name: PyValue): string {
  return name === null ? "" : cellText(name)
}

function isNumericIndex(index: PdIndex): boolean {
  const probe = Math.min(index.length, 1000)
  for (let i = 0; i < probe; i++) if (typeof index.at(i) !== "number") return false
  return true
}

/** Whether a 1-D array holds only numbers (or None), with at least one number. */
function isNumericList(array: NdArray, count: number): boolean {
  if (array.raw) return ["f", "i", "u"].includes(array.dtype?.kind ?? "")
  let numbers = 0
  for (let i = 0; i < count; i++) {
    const value = array.at(i)
    if (typeof value === "number") numbers++
    else if (value !== null) return false
  }
  return numbers > 0
}

/** A single-series chart of `count` values over their position. */
function chartOf(label: string, count: number, at: (i: number) => PyValue): DataFilePreview {
  const x: number[] = []
  const y: Array<number | null> = []
  for (let i = 0; i < count; i++) {
    x.push(i)
    const value = at(i)
    y.push(typeof value === "number" && Number.isFinite(value) ? value : null)
  }
  return downsampleChart("index", x, [label], [y])
}

/** A bounded grid of cells. */
function grid(
  dtype: string,
  shape: number[],
  rowCount: number,
  colCount: number,
  at: (row: number, col: number) => PyValue,
): ArrayPreview {
  const shownCols = Math.min(colCount, MAX_ARRAY_COLS)
  const shownRows = Math.min(rowCount, MAX_ARRAY_ROWS)
  const rows: string[][] = []
  for (let r = 0; r < shownRows; r++) {
    const row: string[] = []
    for (let c = 0; c < shownCols; c++) row.push(cellText(at(r, c)))
    rows.push(row)
  }
  return {
    type: "array",
    dtype,
    shape,
    columns: Array.from({ length: shownCols }, (_, c) => `c${c}`),
    rows,
    truncated: rowCount > MAX_ARRAY_ROWS || colCount > MAX_ARRAY_COLS,
  }
}

/** One value as table text. */
function cellText(value: PyValue): string {
  if (value === null) return "None"
  if (typeof value === "number") return Number.isFinite(value) ? formatCell(value) : String(value)
  if (typeof value === "string") return value
  if (typeof value === "boolean") return value ? "True" : "False"
  if (typeof value === "bigint") return String(value)
  return JSON.stringify(toJson(value, 2, { left: 1000 }))
}

/** Items shown per list in the JSON view. */
const MAX_JSON_ITEMS = 200
/** Nesting shown in the JSON view. */
const MAX_JSON_DEPTH = 20

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Values visited for one JSON view: shared or self-referencing lists stop here. */
const MAX_JSON_NODES = 20_000

/** Pretty-printed JSON of a value, at most {@link MAX_TEXT_BYTES} long. */
function boundedJson(value: PyValue): string {
  const text = JSON.stringify(toJson(value, MAX_JSON_DEPTH, { left: MAX_JSON_NODES }), null, 2)
  return text.length > MAX_TEXT_BYTES ? `${text.slice(0, MAX_TEXT_BYTES)}\n…` : text
}

/** A JSON-able view of a value: long lists are cut, other objects summarized. */
function toJson(value: PyValue, depth: number, budget: { left: number }): Json {
  budget.left--
  if (value === null || typeof value === "boolean" || typeof value === "string") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
  if (typeof value === "bigint") return String(value)
  if (depth <= 0 || budget.left <= 0) return "…"
  const list = (items: PyValue[]): Json[] => {
    const out = items.slice(0, MAX_JSON_ITEMS).map((item) => toJson(item, depth - 1, budget))
    if (items.length > MAX_JSON_ITEMS) out.push(`… ${items.length - MAX_JSON_ITEMS} more items`)
    return out
  }
  if (Array.isArray(value)) return list(value)
  if (value instanceof PyTuple || value instanceof PySet) return list(value.items)
  if (value instanceof PyDict) {
    // No prototype, so a `__proto__` key is kept as a key.
    const out: { [key: string]: Json } = Object.create(null)
    for (const [key, item] of value.entries.slice(0, MAX_JSON_ITEMS)) {
      out[typeof key === "string" ? key : cellText(key)] = toJson(item, depth - 1, budget)
    }
    if (value.entries.length > MAX_JSON_ITEMS) {
      out["…"] = `${value.entries.length - MAX_JSON_ITEMS} more keys`
    }
    return out
  }
  if (value instanceof PyBytes) {
    const shown = [...value.data.subarray(0, 64)]
      .map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`)
      .join("")
    return `b'${shown}${value.data.length > 64 ? "…" : ""}'`
  }
  if (value instanceof NdArray) {
    if (value.length <= MAX_JSON_ITEMS && value.shape.length <= 1) {
      return value.shape.length === 0
        ? toJson(value.at(0), depth - 1, budget)
        : list(Array.from({ length: value.length }, (_, i) => value.at(i)))
    }
    return `ndarray ${value.dtype?.descr ?? "|O"} shape (${value.shape.join(", ")})`
  }
  if (value instanceof PdFrame) {
    return `DataFrame (${value.index?.length ?? 0} rows × ${value.columns.length} columns)`
  }
  if (value instanceof PdSeries) return `Series (${value.values?.length ?? 0} values)`
  if (value instanceof PySlice) return `slice(${cellText(value.start)}, ${cellText(value.stop)})`
  if (value instanceof PyGlobal || value instanceof PyOpaque) return describeClass(value)
  return describeClass(value)
}
