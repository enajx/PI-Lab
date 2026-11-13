import type { DataFileKind } from "@pi-lab/shared"
import type { ParsedNotebook } from "@pi-lab/shared/analysis/ipynb"

/**
 * The preview shapes Analysis returns, their size limits, and the shared
 * helpers that build charts from rows. Used by `discover.ts` and the format
 * readers (pickle, HDF5, Parquet).
 */

/** Rows of a CSV/TSV sampled into a header + body. */
export interface TablePreview {
  type: "table"
  /** Column headers (first row of the file). */
  headers: string[]
  /** Up to {@link MAX_TABLE_ROWS} body rows, each aligned to `headers`. */
  rows: string[][]
  /** Total data rows in the file (header excluded), exact when not truncated. */
  totalRows: number
  /** True iff more than {@link MAX_TABLE_ROWS} rows exist. */
  truncated: boolean
}

/** A pretty-printed JSON document. */
export interface JsonPreview {
  type: "json"
  /** 2-space-indented JSON text (re-serialized from the parse). */
  text: string
}

/** An inline-renderable image as a data URL. */
export interface ImagePreview {
  type: "image"
  /** `data:<mime>;base64,…` — bounded by {@link MAX_IMAGE_BYTES}. */
  dataUrl: string
}

/** The head of a text file. */
export interface TextPreview {
  type: "text"
  /** First chunk of the file (bounded by {@link MAX_TEXT_BYTES}). */
  text: string
  /** True iff the file is longer than the returned chunk. */
  truncated: boolean
}

/** Metadata-only fallback for kinds with no inline renderer (or on parse error). */
export interface MetadataPreview {
  type: "metadata"
  /** The file's classified kind (so the UI can label the fallback). */
  kind: DataFileKind
  size: number
  mtime: number
  /** Optional reason the richer preview was not produced (e.g. parse failed). */
  note?: string
}

/** One labelled series of points for a {@link ChartPreview} line chart. */
export interface ChartSeries {
  /** Series name (column header / array column label), used as the legend key. */
  label: string
  /** Y values aligned 1:1 with the chart's shared x axis; `null` = a gap. */
  values: Array<number | null>
}

/**
 * A numeric file detected as a line-chartable scalar series — a shared,
 * monotonic x axis (an index/step column) plus one or more y series. Produced
 * for numeric CSV/TSV that look like metric logs and for 1-D `.npy` arrays.
 */
export interface ChartPreview {
  type: "chart"
  /** Axis label for the shared x values (the step/index column header). */
  xLabel: string
  /** The shared, monotonic x values (one per plotted point). */
  x: number[]
  /** One or more y series, each aligned 1:1 with {@link x}. */
  series: ChartSeries[]
  /** True iff the source had more points than were sampled into the chart. */
  truncated: boolean
}

/**
 * A decoded numeric array (a `.npy` 1-D/2-D array, or any array-shaped data)
 * rendered as a bounded grid. 1-D arrays become a single column; 2-D arrays
 * keep their row/column layout. Cells are stringified for transport.
 */
export interface ArrayPreview {
  type: "array"
  /** Reported dtype string (e.g. `<f8`), for the header chip. */
  dtype: string
  /** Full array shape, e.g. `[1000]` or `[64, 8]` (pre-truncation). */
  shape: number[]
  /** Column headers (`c0`, `c1`, … or a single value column for 1-D). */
  columns: string[]
  /** Up to {@link MAX_ARRAY_ROWS} rows, each aligned to `columns`. */
  rows: string[][]
  /** True iff more than {@link MAX_ARRAY_ROWS} rows exist. */
  truncated: boolean
}

/** A Jupyter notebook's cells with their stored outputs (see {@link parseIpynb}). */
export interface NotebookPreview extends ParsedNotebook {
  type: "notebook"
}

export type DataFilePreview =
  | NotebookPreview
  | TablePreview
  | JsonPreview
  | ImagePreview
  | TextPreview
  | ChartPreview
  | ArrayPreview
  | MetadataPreview
  | DatasetsPreview
  | LargeFilePreview

/** One dataset of an HDF5 file. */
export interface DatasetEntry {
  /** Path inside the file, e.g. `/eval/loss`. */
  path: string
  shape: number[]
  /** h5wasm's dtype text, e.g. `<d` or `compound(step, acc)`. */
  dtype: string
}

/** A file holding several datasets (HDF5): the list and a preview of one. */
export interface DatasetsPreview {
  type: "datasets"
  datasets: DatasetEntry[]
  /** True iff the file has more datasets than are listed. */
  truncated: boolean
  /** The previewed dataset's path. */
  selected: string
  preview: Exclude<DataFilePreview, DatasetsPreview | LargeFilePreview>
}

/**
 * A file above its format's size limit ({@link LARGE_FILE_BYTES}): it is not
 * read until the user asks (the preview is requested again with `load`).
 */
export interface LargeFilePreview {
  type: "large"
  kind: DataFileKind
  size: number
}

/** Max body rows returned for a CSV/TSV preview. */
export const MAX_TABLE_ROWS = 50
/** Max raw bytes read for a CSV/TSV / JSON / text preview. */
export const MAX_TEXT_BYTES = 512 * 1024
/** Max bytes for an inline image (over this → metadata fallback). */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
/** Max plotted points per chart (longer series are downsampled to this). */
export const MAX_CHART_POINTS = 1000
/** Max rows shown in an {@link ArrayPreview} grid. */
export const MAX_ARRAY_ROWS = 200
/** Max columns shown in an {@link ArrayPreview} grid (a 2-D array's width). */
export const MAX_ARRAY_COLS = 32
/** Max bytes of a `.ipynb` read for its preview (over this → metadata fallback). */
export const MAX_NOTEBOOK_BYTES = 16 * 1024 * 1024
/** Max bytes of a pickle (a `.pkl` or an object `.npy`), which is read whole. */
export const MAX_PICKLE_BYTES = 256 * 1024 * 1024

/**
 * Per reader, the size above which Analysis asks before reading the file
 * (a {@link LargeFilePreview}), or null for no limit. Measured preview times
 * (`md/specs/analysis-artifacts.md`): only pickles, read whole, pass about 1 s
 * (near 45 MB of Python objects); HDF5 and Parquet read only the shown part and
 * stay under 20 ms at 100 MB, as do CSV and numeric NumPy.
 */
export const LARGE_FILE_BYTES: Readonly<Record<"pickle" | "hdf5" | "parquet", number | null>> = {
  pickle: 32 * 1024 * 1024,
  hdf5: null,
  parquet: null,
}

// ── Scalar-curve detection (CSV/TSV → line chart) ──────────────────────────────

/**
 * Fraction of a numeric column's non-empty cells that must parse as finite
 * numbers for the column to count as "numeric". Tolerates the odd `NaN`/blank.
 */
const NUMERIC_COLUMN_THRESHOLD = 0.8
/**
 * Fraction of a candidate x column's steps that must be non-decreasing for it to
 * read as a monotonic index/step axis (≈ allows a couple of out-of-order rows).
 */
const MONOTONIC_THRESHOLD = 0.95

/** Missing cells remain missing; a literal zero remains a measurement. */
export function numericCell(cell: string | undefined): number | null {
  if (cell === undefined || cell.trim() === "") return null
  const value = Number(cell)
  return Number.isFinite(value) ? value : null
}

/** Whether at least {@link NUMERIC_COLUMN_THRESHOLD} of column `col` is numeric. */
function isNumericColumn(rows: string[][], col: number): boolean {
  let numeric = 0
  let nonEmpty = 0
  for (const row of rows) {
    const cell = row[col]
    if (cell === undefined || cell.trim() === "") continue
    nonEmpty++
    if (numericCell(cell) !== null) numeric++
  }
  return nonEmpty > 0 && numeric / nonEmpty >= NUMERIC_COLUMN_THRESHOLD
}

/** Whether column `col` is monotonically non-decreasing (skipping non-numbers). */
function isMonotonicColumn(rows: string[][], col: number): boolean {
  let prev = Number.NEGATIVE_INFINITY
  let seen = 0
  let ordered = 0
  for (const row of rows) {
    const value = numericCell(row[col])
    if (value === null) continue
    seen++
    if (value >= prev) ordered++
    prev = value
  }
  return seen > 1 && ordered / seen >= MONOTONIC_THRESHOLD
}

/**
 * Decide whether a parsed CSV/TSV looks like a scalar metric log — a monotonic
 * first numeric column (the step/index axis) followed by ≥1 further numeric
 * column (the plotted series) — and if so build a {@link ChartPreview}. Pure;
 * returns `null` (→ fall back to a table) when the heuristic rejects.
 */
export function detectScalarChart(headers: string[], rows: string[][]): ChartPreview | null {
  if (headers.length < 2 || rows.length < 2) return null

  const numericCols: number[] = []
  for (let col = 0; col < headers.length; col++) {
    if (isNumericColumn(rows, col)) numericCols.push(col)
  }
  if (numericCols.length < 2) return null

  const xCol = numericCols[0] ?? 0
  if (!isMonotonicColumn(rows, xCol)) return null
  const seriesCols = numericCols.slice(1)

  return buildChart({
    rows,
    xCol,
    xLabel: headers[xCol] ?? "step",
    seriesCols,
    seriesLabels: seriesCols.map((col) => headers[col] ?? `col${col}`),
  })
}

/**
 * Assemble a {@link ChartPreview} from string rows: read the x column and each
 * series column as numbers, drop rows whose x is not finite, and downsample to
 * {@link MAX_CHART_POINTS} by striding so a long log still charts cheaply.
 */
function buildChart(args: {
  rows: string[][]
  xCol: number
  xLabel: string
  seriesCols: number[]
  seriesLabels: string[]
}): ChartPreview {
  const { rows, xCol, xLabel, seriesCols, seriesLabels } = args

  const xAll: number[] = []
  const seriesAll: Array<Array<number | null>> = seriesCols.map(() => [])
  for (const row of rows) {
    const x = numericCell(row[xCol])
    if (x === null) continue
    xAll.push(x)
    seriesCols.forEach((col, s) => {
      seriesAll[s]?.push(numericCell(row[col]))
    })
  }

  return downsampleChart(xLabel, xAll, seriesLabels, seriesAll)
}

/** Stride a chart's x + series down to at most {@link MAX_CHART_POINTS} points. */
export function downsampleChart(
  xLabel: string,
  xAll: number[],
  seriesLabels: string[],
  seriesAll: Array<Array<number | null>>,
): ChartPreview {
  const truncated = xAll.length > MAX_CHART_POINTS
  const stride = truncated ? Math.ceil(xAll.length / MAX_CHART_POINTS) : 1

  const x: number[] = []
  const sampled: Array<Array<number | null>> = seriesAll.map(() => [])
  for (let i = 0; i < xAll.length; i += stride) {
    x.push(xAll[i] ?? 0)
    seriesAll.forEach((values, s) => {
      sampled[s]?.push(values[i] ?? null)
    })
  }

  return {
    type: "chart",
    xLabel,
    x,
    series: seriesLabels.map((label, s) => ({ label, values: sampled[s] ?? [] })),
    truncated,
  }
}

/** Stringify one array cell: a finite number is trimmed to 6 sig-figs, else `""`. */
export function formatCell(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return ""
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)))
}
