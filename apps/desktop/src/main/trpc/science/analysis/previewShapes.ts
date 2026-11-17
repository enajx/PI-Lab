import type { DataFileKind } from "@pi-lab/shared"
import type { ParsedNotebook } from "@pi-lab/shared/analysis/ipynb"

/**
 * The preview shapes Analysis returns, their size limits, and the shared
 * helpers that build charts from rows. Used by `discover.ts` and the format
 * readers (pickle, HDF5, Parquet).
 */

/**
 * A table (CSV/TSV, Parquet, a pickled DataFrame or list of dicts, an HDF5
 * compound dataset): its first rows, what each column holds, and whether it
 * opens as a table or a chart (see `tables.ts`).
 */
export interface TablePreview {
  type: "table"
  /** Column headers. */
  headers: string[]
  /** Up to {@link MAX_TABLE_ROWS} body rows, each aligned to `headers`. */
  rows: string[][]
  /** Data rows read (header excluded); the file's total unless `partial`. */
  totalRows: number
  /** True iff more than {@link MAX_TABLE_ROWS} rows exist. */
  truncated: boolean
  /** True when only the first part of the file was read, so `totalRows` is a lower bound. */
  partial: boolean
  /** What each column holds, aligned to `headers`. */
  columns: ColumnInfo[]
  /** "chart" for a metric log (a unique, increasing step column), else "table". */
  defaultView: "table" | "chart"
  /** The chart shown when the user switches to Chart; null when no column can be plotted. */
  defaultSpec: ChartSpec | null
}

/**
 * What a table column holds. `step`: numbers that increase row by row (a
 * metric log's x axis). `factor`: a design or grouping column (text with few
 * values, True/False, or integers with few values or many repeats).
 * `measure`: other numbers. `text`: text with many values (ids, prompts).
 * `index`: a pickled DataFrame's unnamed row index.
 */
export type ColumnRole = "step" | "factor" | "measure" | "text" | "index"

export interface ColumnInfo {
  name: string
  role: ColumnRole
  /** How the values are read: True/False count as 0/1 in charts; text only as x or split. */
  kind: "number" | "bool" | "text"
}

export type ChartType = "line" | "scatter" | "bar"
/** How rows with the same x value are combined; "none" plots every row. */
export type ChartAggregate = "none" | "mean" | "median" | "sum" | "count"
/** The spread drawn around a mean or median: min to max, ±1 std, or the 95% CI of the mean. */
export type ChartBand = "none" | "minmax" | "std" | "ci95"

/** How the chart builder plots a table (the user's "Chart settings"). */
export interface ChartSpec {
  x: string
  y: string[]
  /** Draw one series per value of this column, or null for one series per y column. */
  splitBy: string | null
  chartType: ChartType
  aggregate: ChartAggregate
  band: ChartBand
}

/** One series of a {@link PlotPreview}, with its own x values. */
export interface PlotSeries {
  label: string
  x: number[]
  /** Aligned 1:1 with `x`; `null` = a gap. */
  y: Array<number | null>
  /** The band's lower and upper edges, aligned with `x`, or null without a band. */
  lo: number[] | null
  hi: number[] | null
}

/** A table plotted with a {@link ChartSpec} (`science.analysis.chart`). */
export interface PlotPreview {
  type: "plot"
  chartType: ChartType
  xLabel: string
  /** For a text x column: the category names, and each x value is an index into them. */
  xCategories: string[] | null
  series: PlotSeries[]
  /** Rows the chart was built from. */
  rowsUsed: number
  /** True when the file has more rows than {@link MAX_FRAME_ROWS}, so the chart covers only part of it. */
  partial: boolean
  /** True when a series had more than {@link MAX_PLOT_POINTS} points and was strided. */
  downsampled: boolean
  /** Things the user should know, e.g. split values that were left out. */
  notes: string[]
}

/** A function that combines the values of a group into one. */
export type AggFunction =
  | "count"
  | "nunique"
  | "sum"
  | "mean"
  | "median"
  | "min"
  | "max"
  | "std"
  | "sem"
  | "first"
  | "last"

/**
 * One row filter. `eq`/`ne` compare as numbers on numeric columns, else as
 * text; `lt`..`ge` need numbers; `contains` ignores case; `in` keeps rows whose
 * value is one of `values`; `blank`/`notBlank` test for an empty cell.
 */
export interface RowFilter {
  column: string
  op: "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "contains" | "in" | "blank" | "notBlank"
  value: string
  values: string[]
}

/** The one optional aggregation of a table. */
export type Aggregation =
  | { kind: "groupBy"; by: string[]; values: Array<{ column: string; fn: AggFunction }> }
  | { kind: "pivot"; index: string; columns: string; values: string; fn: AggFunction }
  | { kind: "describe" }
  | { kind: "valueCounts"; columns: string[] }

/** What is done to a table before it is shown or charted: filters, then the aggregation, then the sort. */
export interface TableOps {
  filters: RowFilter[]
  aggregation: Aggregation | null
  sort: Array<{ column: string; descending: boolean }>
}

/** Rows `offset`.. of a table after its {@link TableOps} (`science.analysis.table`). */
export interface TablePage {
  headers: string[]
  columns: ColumnInfo[]
  /** The rows of this page as text; numbers keep up to 12 significant digits. */
  rows: string[][]
  offset: number
  /** Rows in the result. */
  totalRows: number
  /** True when the file has more rows than were read, so the result covers only its first part. */
  partial: boolean
  /** Things the user should know, e.g. pivot columns that were left out. */
  notes: string[]
  /** The chart shown for this result when the saved one does not fit it; null when nothing can be plotted. */
  defaultSpec: ChartSpec | null
}

/** Most rows read from a table for its column summary and charts. */
export const MAX_FRAME_ROWS = 100_000
/** Most bytes of a CSV/TSV read for its column summary and charts. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024
/** Most points drawn per series of a {@link PlotPreview}. */
export const MAX_PLOT_POINTS = 2000

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
 * A file above its format's size limit ({@link LARGE_FILE_BYTES}) or above
 * {@link HUGE_FILE_BYTES}: it is not read until the user asks (the preview is
 * requested again with `load`).
 */
export interface LargeFilePreview {
  type: "large"
  kind: DataFileKind
  size: number
  /** True above {@link HUGE_FILE_BYTES}: loading may be slow or fail. */
  huge: boolean
  /** What could be read safely without loading (a CSV's first rows, a text head), or null. */
  partial: DataFilePreview | null
}

/** Above this size every file asks before it is read, and shows only a safe part. */
export const HUGE_FILE_BYTES = 1024 * 1024 * 1024

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

// ── Chart helpers ────────────────────────────────────────────────────────────

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
