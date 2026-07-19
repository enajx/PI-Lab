import type { Dirent } from "node:fs"
import { open, readdir, readFile, stat } from "node:fs/promises"
import { extname, join, relative } from "node:path"
import {
  ALL_DATA_FILE_KINDS,
  classifyAnalysisArtifact,
  classifyDataFile,
  type DataFileKind,
} from "@pi-lab/shared"
import { DEFAULT_IGNORED_DIRS } from "@pi-lab/workspace-fs"
import { TRPCError } from "@trpc/server"

/**
 * Filesystem layer for the Analysis science tab (P8c). Plain, side-effecting
 * functions kept out of the tRPC router so the router stays a thin one-liner and
 * the discovery/preview logic is independently reasoned about. No DB access, no
 * tRPC context — just paths and bytes.
 */

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Hard cap on the number of files a single `listFiles` walk returns. Guards a
 * giant repo from producing an unbounded IPC payload; when hit, the listing's
 * `truncated` flag is set so the UI can surface "showing N of more" rather than
 * silently dropping files (AGENTS.md — no silent caps).
 */
export const MAX_LISTED_FILES = 2000

/**
 * Extra noise directories pruned from the Analysis walk, on top of
 * `workspace-fs`'s `DEFAULT_IGNORED_DIRS` (`.git`, `node_modules`, …). Heavy or
 * uninteresting trees that would dilute a data browser (Python caches,
 * virtualenvs, build outputs, editor dirs).
 */
const EXTRA_IGNORED_DIRS = [
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".mypy_cache",
  ".pytest_cache",
  ".ipynb_checkpoints",
  "build",
  "out",
  ".next",
  ".idea",
  ".vscode",
] as const

/** One discovered artifact, tagged with its kind and lightweight metadata. */
export interface DataFileEntry {
  /** Repo-relative path (POSIX separators), the stable id / preview key. */
  relPath: string
  /** Final path segment, for the list label. */
  name: string
  /** Classified kind (drives grouping + which preview to request). */
  kind: DataFileKind
  /** Size in bytes. */
  size: number
  /** Last-modified time, epoch ms. */
  mtime: number
}

/** Files of one kind, for grouped rendering in the UI. */
export interface DataFileGroup {
  kind: DataFileKind
  files: DataFileEntry[]
}

/** The `listFiles` result: grouped files plus the truncation signal. */
export interface DataFileListing {
  /** Non-empty groups, in canonical kind order. */
  groups: DataFileGroup[]
  /** Total files returned across all groups (≤ {@link MAX_LISTED_FILES}). */
  total: number
  /** True iff the walk hit {@link MAX_LISTED_FILES} and stopped early. */
  truncated: boolean
}

/**
 * Walk a repo for explicitly whitelisted data/analysis artifacts. Source,
 * compiled, and unknown files never enter the candidate set, so the cap applies
 * after filtering and a source-heavy directory cannot starve deeper results.
 * `.zarr` directories are collected as one metadata-only dataset and pruned.
 */
export async function discoverDataFiles(repoPath: string): Promise<DataFileListing> {
  const candidates = await walkAnalysisArtifacts(repoPath, MAX_LISTED_FILES + 1)
  const truncated = candidates.length > MAX_LISTED_FILES
  const kept = truncated ? candidates.slice(0, MAX_LISTED_FILES) : candidates

  const entries: DataFileEntry[] = []
  for (const { abs, kind } of kept) {
    const relPath = toPosix(relative(repoPath, abs))
    const name = relPath.slice(relPath.lastIndexOf("/") + 1)
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(abs)
    } catch {
      // Vanished or unreadable between walk and stat — skip it.
      continue
    }
    entries.push({
      relPath,
      name,
      kind,
      size: info.size,
      mtime: info.mtimeMs,
    })
  }

  const byKind = new Map<DataFileKind, DataFileEntry[]>()
  for (const entry of entries) {
    const bucket = byKind.get(entry.kind)
    if (bucket) bucket.push(entry)
    else byKind.set(entry.kind, [entry])
  }

  const groups: DataFileGroup[] = []
  for (const kind of ALL_DATA_FILE_KINDS) {
    const files = byKind.get(kind)
    if (!files || files.length === 0) continue
    files.sort((a, b) => a.relPath.localeCompare(b.relPath))
    groups.push({ kind, files })
  }

  return { groups, total: entries.length, truncated }
}

interface AnalysisArtifactCandidate {
  abs: string
  kind: DataFileKind
}

/**
 * Breadth-first whitelist-aware traversal. Unlike the generic workspace walker,
 * rejected files do not consume `limit`. Directory artifacts are collected only
 * for `.zarr`; all other eligible artifacts are regular files.
 */
async function walkAnalysisArtifacts(
  repoPath: string,
  limit: number,
): Promise<AnalysisArtifactCandidate[]> {
  const ignored = new Set([...DEFAULT_IGNORED_DIRS, ...EXTRA_IGNORED_DIRS])
  const artifacts: AnalysisArtifactCandidate[] = []
  let frontier = [repoPath]

  while (frontier.length > 0 && artifacts.length < limit) {
    const next: string[] = []
    for (const dir of frontier) {
      let dirents: Dirent[]
      try {
        dirents = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name))

      for (const dirent of dirents) {
        if (dirent.name.startsWith(".")) continue
        const abs = join(dir, dirent.name)
        if (dirent.isFile()) {
          const kind = classifyAnalysisArtifact(dirent.name, "file")
          if (kind !== null) artifacts.push({ abs, kind })
        } else if (dirent.isDirectory() && !ignored.has(dirent.name)) {
          const kind = classifyAnalysisArtifact(dirent.name, "directory")
          if (kind !== null) artifacts.push({ abs, kind })
          else next.push(abs)
        }
        if (artifacts.length >= limit) return artifacts
      }
    }
    frontier = next
  }

  return artifacts
}

// ── Preview ──────────────────────────────────────────────────────────────────

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

export type DataFilePreview =
  | TablePreview
  | JsonPreview
  | ImagePreview
  | TextPreview
  | ChartPreview
  | ArrayPreview
  | MetadataPreview

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
/** Max bytes read when decoding a `.npy` array (over this → metadata fallback). */
export const MAX_NPY_BYTES = 16 * 1024 * 1024

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
}

/**
 * Build a bounded preview of one file, dispatched by its classified kind. `abs`
 * is the already-jailed absolute path; `relPath` is carried only to classify and
 * report. A missing file is a clean NOT_FOUND; any kind we can't render richly —
 * or that fails to parse — degrades to a {@link MetadataPreview} rather than
 * erroring, so the UI always has something to show.
 */
export async function previewDataFile(abs: string, relPath: string): Promise<DataFilePreview> {
  const kind = classifyDataFile(relPath)

  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(abs)
  } catch {
    throw new TRPCError({ code: "NOT_FOUND", message: `No file ${relPath}` })
  }
  const isZarrDirectory = info.isDirectory() && extname(relPath).toLowerCase() === ".zarr"
  if (!info.isFile() && !isZarrDirectory) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Not a file: ${relPath}` })
  }

  const meta = (note?: string): MetadataPreview => ({
    type: "metadata",
    kind,
    size: info.size,
    mtime: info.mtimeMs,
    note,
  })

  switch (kind) {
    case "csv":
    case "tsv":
      return previewTable(abs, kind === "tsv" ? "\t" : ",", meta)
    case "json":
      return previewJson(abs, meta)
    case "image":
      return previewImage(abs, relPath, info.size, meta)
    case "markdown":
    case "text":
      return previewText(abs)
    case "npy":
      return previewNpy(abs, relPath, info.size, meta)
    default:
      // Binary stores (including pickle), reports, notebooks, plots, and Zarr
      // directories are intentionally metadata-only: never deserialize or read.
      return meta()
  }
}

/** Read at most {@link MAX_TEXT_BYTES} of a file as UTF-8, flagging a cutoff. */
async function readBoundedText(abs: string): Promise<{ text: string; truncated: boolean }> {
  const file = await open(abs, "r")
  try {
    const buf = Buffer.allocUnsafe(MAX_TEXT_BYTES + 1)
    const { bytesRead } = await file.read(buf, 0, buf.length, 0)
    const truncated = bytesRead > MAX_TEXT_BYTES
    const length = Math.min(bytesRead, MAX_TEXT_BYTES)
    return { text: buf.subarray(0, length).toString("utf8"), truncated }
  } finally {
    await file.close()
  }
}

async function previewText(abs: string): Promise<TextPreview> {
  const { text, truncated } = await readBoundedText(abs)
  return { type: "text", text, truncated }
}

async function previewJson(
  abs: string,
  meta: (note?: string) => MetadataPreview,
): Promise<DataFilePreview> {
  const { text, truncated } = await readBoundedText(abs)
  // A truncated read can't be valid JSON; fall back rather than parse a fragment.
  if (truncated) return meta("File too large to parse as JSON")
  try {
    const parsed = JSON.parse(text)
    return { type: "json", text: JSON.stringify(parsed, null, 2) }
  } catch {
    return meta("Invalid JSON")
  }
}

async function previewImage(
  abs: string,
  relPath: string,
  size: number,
  meta: (note?: string) => MetadataPreview,
): Promise<DataFilePreview> {
  if (size > MAX_IMAGE_BYTES) return meta("Image too large to preview inline")
  const mime = IMAGE_MIME_BY_EXT[extname(relPath).toLowerCase()] ?? "application/octet-stream"
  const buf = await readFile(abs)
  return { type: "image", dataUrl: `data:${mime};base64,${buf.toString("base64")}` }
}

async function previewTable(
  abs: string,
  delimiter: string,
  meta: (note?: string) => MetadataPreview,
): Promise<DataFilePreview> {
  const { text, truncated: bytesTruncated } = await readBoundedText(abs)
  const lines = splitLines(text)
  if (lines.length === 0) return meta("Empty file")

  const headers = parseDelimited(lines[0] ?? "", delimiter)
  const bodyLines = lines.slice(1)
  const allRows = bodyLines.map((line) => parseDelimited(line, delimiter))

  // A numeric, metric-log-shaped table (monotonic x column + ≥1 numeric series)
  // renders as a line chart instead of a grid. We only attempt this when the
  // whole file was read, so the monotonicity check sees every row.
  if (!bytesTruncated) {
    const chart = detectScalarChart(headers, allRows)
    if (chart) return chart
  }

  // Otherwise a sampled table: first MAX_TABLE_ROWS rows; totalRows is exact
  // when we read the whole file, else an estimate flagged via `truncated`.
  const sampled = allRows.slice(0, MAX_TABLE_ROWS)
  const truncated = bytesTruncated || bodyLines.length > MAX_TABLE_ROWS

  return {
    type: "table",
    headers,
    rows: sampled,
    totalRows: bodyLines.length,
    truncated,
  }
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

/** Whether at least {@link NUMERIC_COLUMN_THRESHOLD} of column `col` is numeric. */
function isNumericColumn(rows: string[][], col: number): boolean {
  let numeric = 0
  let nonEmpty = 0
  for (const row of rows) {
    const cell = row[col]
    if (cell === undefined || cell === "") continue
    nonEmpty++
    if (!Number.isNaN(Number(cell))) numeric++
  }
  return nonEmpty > 0 && numeric / nonEmpty >= NUMERIC_COLUMN_THRESHOLD
}

/** Whether column `col` is monotonically non-decreasing (skipping non-numbers). */
function isMonotonicColumn(rows: string[][], col: number): boolean {
  let prev = Number.NEGATIVE_INFINITY
  let seen = 0
  let ordered = 0
  for (const row of rows) {
    const value = Number(row[col])
    if (!Number.isFinite(value)) continue
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
function detectScalarChart(headers: string[], rows: string[][]): ChartPreview | null {
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
    const x = Number(row[xCol])
    if (!Number.isFinite(x)) continue
    xAll.push(x)
    seriesCols.forEach((col, s) => {
      const value = Number(row[col])
      seriesAll[s]?.push(Number.isFinite(value) ? value : null)
    })
  }

  return downsampleChart(xLabel, xAll, seriesLabels, seriesAll)
}

/** Stride a chart's x + series down to at most {@link MAX_CHART_POINTS} points. */
function downsampleChart(
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

// ── NumPy (.npy) decoding ──────────────────────────────────────────────────────

/** The 6 magic bytes that prefix every `.npy` file: `\x93NUMPY`. */
const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59] as const

/** Reader for one supported little/big-endian dtype, keyed by its descr suffix. */
interface NpyDtype {
  /** Byte width of one element. */
  width: number
  /** Read one element from `view` at `offset`. */
  read: (view: DataView, offset: number, littleEndian: boolean) => number
}

/** The numeric dtypes we decode (float + signed/unsigned int, 1–8 bytes). */
const NPY_DTYPES: Readonly<Record<string, NpyDtype>> = {
  f8: { width: 8, read: (v, o, le) => v.getFloat64(o, le) },
  f4: { width: 4, read: (v, o, le) => v.getFloat32(o, le) },
  i8: { width: 8, read: (v, o, le) => Number(v.getBigInt64(o, le)) },
  i4: { width: 4, read: (v, o, le) => v.getInt32(o, le) },
  i2: { width: 2, read: (v, o, le) => v.getInt16(o, le) },
  i1: { width: 1, read: (v, o) => v.getInt8(o) },
  u8: { width: 8, read: (v, o, le) => Number(v.getBigUint64(o, le)) },
  u4: { width: 4, read: (v, o, le) => v.getUint32(o, le) },
  u2: { width: 2, read: (v, o, le) => v.getUint16(o, le) },
  u1: { width: 1, read: (v, o) => v.getUint8(o) },
}

/** A successfully decoded `.npy` 1-D/2-D numeric array (row-major values). */
interface DecodedNpy {
  /** Row-major flattened values (length = product of `shape`). */
  values: Float64Array
  /** Array shape: `[n]` for 1-D, `[rows, cols]` for 2-D. */
  shape: number[]
  /** Original dtype descr (e.g. `<f8`). */
  dtype: string
}

/** Parse the `.npy` header dict text into descr / fortran_order / shape. */
function parseNpyHeader(
  header: string,
): { descr: string; fortranOrder: boolean; shape: number[] } | null {
  const descr = header.match(/'descr'\s*:\s*'([^']+)'/)
  const fortran = header.match(/'fortran_order'\s*:\s*(True|False)/)
  const shapeText = header.match(/'shape'\s*:\s*\(([^)]*)\)/)
  if (!descr || !fortran || !shapeText) return null
  const shape = (shapeText[1] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => Number.isFinite(n))
  return { descr: descr[1] ?? "", fortranOrder: fortran[1] === "True", shape }
}

/**
 * Decode a `.npy` buffer into a 1-D/2-D numeric array. Pure and total: any
 * malformed/unsupported input (bad magic, an unsupported dtype, >2 dimensions,
 * a scalar, or truncated data) yields `null` rather than throwing, so the caller
 * can degrade to a metadata card.
 *
 * Format spec: https://numpy.org/doc/stable/reference/generated/numpy.lib.format.html
 */
export function decodeNpy(buf: Buffer): DecodedNpy | null {
  if (buf.length < 10) return null
  for (let i = 0; i < NPY_MAGIC.length; i++) {
    if (buf[i] !== NPY_MAGIC[i]) return null
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const major = buf[6]
  let headerLen: number
  let headerStart: number
  if (major === 1) {
    headerLen = view.getUint16(8, true)
    headerStart = 10
  } else if (major === 2 || major === 3) {
    headerLen = view.getUint32(8, true)
    headerStart = 12
  } else {
    return null
  }

  const dataOffset = headerStart + headerLen
  const header = buf.toString("utf8", headerStart, dataOffset)
  const parsed = parseNpyHeader(header)
  if (!parsed) return null
  // Only 1-D / 2-D numeric arrays are renderable; scalars and N-D arrays fall back.
  if (parsed.shape.length === 0 || parsed.shape.length > 2) return null

  const littleEndian = parsed.descr.startsWith("<") || parsed.descr.startsWith("|")
  const dtype = NPY_DTYPES[parsed.descr.slice(1)]
  if (!dtype) return null

  const total = parsed.shape.reduce((a, b) => a * b, 1)
  if (dataOffset + total * dtype.width > buf.length) return null

  const values = new Float64Array(total)
  if (parsed.fortranOrder && parsed.shape.length === 2) {
    // Column-major source → row-major destination.
    const [rows = 0, cols = 0] = parsed.shape
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const offset = dataOffset + (c * rows + r) * dtype.width
        values[r * cols + c] = dtype.read(view, offset, littleEndian)
      }
    }
  } else {
    for (let i = 0; i < total; i++) {
      values[i] = dtype.read(view, dataOffset + i * dtype.width, littleEndian)
    }
  }

  return { values, shape: parsed.shape, dtype: parsed.descr }
}

/**
 * Preview a `.npy` array. A 1-D array becomes a {@link ChartPreview} (value vs.
 * row index — the common loss/fitness curve); a 2-D array becomes a bounded
 * {@link ArrayPreview} grid. Oversized files and any decode failure degrade to a
 * metadata card with a note (no throw).
 */
async function previewNpy(
  abs: string,
  relPath: string,
  size: number,
  meta: (note?: string) => MetadataPreview,
): Promise<DataFilePreview> {
  if (size > MAX_NPY_BYTES) return meta("Array too large to decode inline")
  const decoded = decodeNpy(await readFile(abs))
  if (!decoded) return meta("Could not decode .npy array")

  if (decoded.shape.length === 1) return npyChart(decoded, relPath)
  return npyArray(decoded)
}

/** A 1-D `.npy` array → a single-series line chart over its row index. */
function npyChart(decoded: DecodedNpy, relPath: string): ChartPreview {
  const label = baseNameWithoutExt(relPath)
  const xAll = Array.from(decoded.values, (_, i) => i)
  const values = Array.from(decoded.values, (v) => (Number.isFinite(v) ? v : null))
  return downsampleChart("index", xAll, [label], [values])
}

/** A 2-D `.npy` array → a bounded grid (rows × columns, both capped). */
function npyArray(decoded: DecodedNpy): ArrayPreview {
  const [rowCount = 0, colCount = 0] = decoded.shape
  const shownCols = Math.min(colCount, MAX_ARRAY_COLS)
  const shownRows = Math.min(rowCount, MAX_ARRAY_ROWS)

  const columns = Array.from({ length: shownCols }, (_, c) => `c${c}`)
  const rows: string[][] = []
  for (let r = 0; r < shownRows; r++) {
    const row: string[] = []
    for (let c = 0; c < shownCols; c++) row.push(formatCell(decoded.values[r * colCount + c]))
    rows.push(row)
  }

  return {
    type: "array",
    dtype: decoded.dtype,
    shape: decoded.shape,
    columns,
    rows,
    truncated: rowCount > MAX_ARRAY_ROWS || colCount > MAX_ARRAY_COLS,
  }
}

// ── Small pure helpers ───────────────────────────────────────────────────────

/** Normalize native (Windows) separators to POSIX for stable relPaths. */
function toPosix(p: string): string {
  return p.replaceAll("\\", "/")
}

/** Final path segment with its extension stripped (e.g. `runs/loss.npy` → `loss`). */
function baseNameWithoutExt(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(0, dot) : base
}

/** Stringify one array cell: a finite number is trimmed to 6 sig-figs, else `""`. */
function formatCell(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return ""
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)))
}

/** Split into lines on `\n`/`\r\n`, dropping a single trailing empty line. */
function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/**
 * Parse one delimited line into fields with minimal RFC-4180 quoting support: a
 * field may be wrapped in double quotes to contain the delimiter or quotes
 * (escaped as `""`). Good enough for a *preview* — not a full CSV engine.
 */
function parseDelimited(line: string, delimiter: string): string[] {
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
