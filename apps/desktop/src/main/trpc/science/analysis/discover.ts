import { open, readFile, stat } from "node:fs/promises"
import { extname, join, relative } from "node:path"
import {
  ALL_DATA_FILE_KINDS,
  classifyAnalysisArtifact,
  classifyDataFile,
  type DataFileKind,
  isMarimoNotebookSource,
} from "@pi-lab/shared"
import { type ParsedNotebook, parseIpynb } from "@pi-lab/shared/analysis/ipynb"
import { walkWorkspace } from "@pi-lab/workspace-fs"
import { TRPCError } from "@trpc/server"
import type { ExperimentsStructure } from "./structure"

/** Filesystem discovery and preview for Analysis, independent of the tRPC router. */

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Cap on the files listed for one experiment (or the files of a group, or the
 * loose files). The walk itself goes through the whole folder, so every
 * experiment is listed however many files there are; one over the cap keeps
 * its first files and is named in `truncatedExperiments` so the UI says so in
 * that row.
 */
export const MAX_LISTED_FILES = 2000
/** Max Python prefix read while deciding whether a `.py` file is a marimo notebook. */
export const MAX_MARIMO_SOURCE_BYTES = 64 * 1024

/**
 * Analysis-only noise directories. Research artifacts in build/out/dist remain
 * visible, while the shared walker excludes dependency, cache, and VCS trees.
 * `_render` holds PI Lab's Quarto and MyST render output and `.quarto` Quarto's
 * own files; neither is an analysis result.
 */
const EXTRA_IGNORED_DIRS = [".next", ".idea", ".vscode", "_render", ".quarto"] as const

export interface DataFileEntry {
  /** Repo-relative path (POSIX separators), the stable id / preview key. */
  relPath: string
  name: string
  kind: DataFileKind
  size: number
  mtime: number
  /**
   * The folder path above the experiment (e.g. `pattern_translation`), shown as
   * a group row, or null when the experiments are at the top (see
   * {@link assignRow}). A file above the experiment level has its group and no
   * experiment.
   */
  group: string | null
  /** The experiment folder the file is in, or null (a file of its group, or loose). */
  experiment: string | null
  /**
   * The file's path inside its row (experiment, group, or the results folder
   * for loose files), POSIX separators; the list shows its folders as a tree.
   */
  innerPath: string
  /** True for a file in the project's `reports/` folder, listed as its own group. */
  inReportsFolder: boolean
}

export interface DataFileGroup {
  kind: DataFileKind
  files: DataFileEntry[]
}

/** An experiment (or group, or loose row) that had more than {@link MAX_LISTED_FILES} files. */
export interface TruncatedExperiment {
  group: string | null
  experiment: string | null
  inReportsFolder: boolean
}

export interface DataFileListing {
  groups: DataFileGroup[]
  total: number
  /** The experiments that kept only their first {@link MAX_LISTED_FILES} files. */
  truncatedExperiments: TruncatedExperiment[]
  /** True when an artifact or child directory vanished or could not be read. */
  partial: boolean
  /** Repo-relative paths skipped due to expected access or disappearance errors. */
  skipped: string[]
}

/**
 * Walk `rootPath` (a folder inside the repo, e.g. its results folder) for
 * explicitly whitelisted data/analysis artifacts. Source, compiled, and unknown
 * files never enter the candidate set. The whole folder is walked; the
 * {@link MAX_LISTED_FILES} cap applies per experiment, so one with many files
 * cannot hide other experiments. `.zarr` directories are
 * collected as one metadata-only dataset and pruned. Paths are returned relative
 * to `repoPath`. For the results folder (`folder: "results"`) each entry's
 * group, experiment and inner path come from `structure` (see {@link assignRow});
 * for the project's reports folder (`folder: "reports"`) entries have no
 * group or experiment, keep their folder tree, and are marked `inReportsFolder`.
 */
export async function discoverDataFiles(
  repoPath: string,
  rootPath: string,
  folder: "results" | "reports",
  structure: ExperimentsStructure,
): Promise<DataFileListing> {
  const walk = await walkAnalysisArtifacts(rootPath)
  const located = walk.artifacts.map(({ abs, kind }) => {
    const underRoot = toPosix(relative(rootPath, abs)).split("/")
    return { abs, kind, folders: underRoot.slice(0, -1), name: underRoot.at(-1) ?? "" }
  })
  const level =
    folder === "results" && structure.kind === "auto"
      ? detectExperimentLevel(located.map((file) => file.folders))
      : 1

  const entries: DataFileEntry[] = []
  const skipped = walk.skipped.map((path) => toPosix(relative(repoPath, join(rootPath, path))))
  // Files kept so far per experiment; one past the cap is recorded once.
  const keptPerExperiment = new Map<string, number>()
  const truncatedExperiments: TruncatedExperiment[] = []
  for (const { abs, kind, folders, name: fileName } of located) {
    const relPath = toPosix(relative(repoPath, abs))
    const name = relPath.slice(relPath.lastIndexOf("/") + 1)
    const row =
      folder === "results"
        ? assignRow(folders, fileName, structure, level)
        : { group: null, experiment: null, innerPath: [...folders, fileName].join("/") }
    const key = `${row.group ?? ""}\u0000${row.experiment ?? ""}`
    const kept = keptPerExperiment.get(key) ?? 0
    if (kept >= MAX_LISTED_FILES) {
      if (kept === MAX_LISTED_FILES) {
        truncatedExperiments.push({
          group: row.group,
          experiment: row.experiment,
          inReportsFolder: folder === "reports",
        })
        keptPerExperiment.set(key, kept + 1)
      }
      continue
    }
    keptPerExperiment.set(key, kept + 1)
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(abs)
    } catch (error) {
      if (!isExpectedChildError(error)) throw error
      skipped.push(relPath)
      continue
    }
    entries.push({
      relPath,
      name,
      kind,
      size: info.size,
      mtime: info.mtimeMs,
      group: row.group,
      experiment: row.experiment,
      innerPath: row.innerPath,
      inReportsFolder: folder === "reports",
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

  return {
    groups,
    total: entries.length,
    truncatedExperiments,
    partial: skipped.length > 0,
    skipped,
  }
}

/**
 * Output folders inside a run (figures, videos, checkpoints…). Auto-detect
 * cuts a path at the first of these, so they never decide the experiment level.
 */
const OUTPUT_FOLDER_NAMES = new Set([
  "animations",
  "plots",
  "figures",
  "runs",
  "checkpoints",
  "logs",
  "videos",
])

/**
 * Auto-detect's experiment level: the folder depth where most runs start.
 * Each file's folders are cut at the first output folder ({@link
 * OUTPUT_FOLDER_NAMES}); the distinct folders left are the runs, and the most
 * common depth among them wins, the shallower one on a tie. 1 means the
 * experiments are the top folders of the results folder (no groups); with no
 * folders at all it is 1 too.
 */
export function detectExperimentLevel(foldersOfFiles: string[][]): number {
  const runs = new Set<string>()
  for (const folders of foldersOfFiles) {
    const cut = folders.findIndex((name) => OUTPUT_FOLDER_NAMES.has(name.toLowerCase()))
    const run = cut === -1 ? folders : folders.slice(0, cut)
    if (run.length > 0) runs.add(run.join("/"))
  }
  const countByDepth = new Map<number, number>()
  for (const run of runs) {
    const depth = run.split("/").length
    countByDepth.set(depth, (countByDepth.get(depth) ?? 0) + 1)
  }
  let level = 1
  let best = 0
  for (const [depth, count] of [...countByDepth].sort((a, b) => a[0] - b[0])) {
    if (count > best) {
      best = count
      level = depth
    }
  }
  return level
}

/**
 * The group, experiment and inner path of a file from the folders between the
 * results folder and the file (`folders`, outermost first).
 *
 * - `auto`: the experiment is the folder at depth `level` (see
 *   {@link detectExperimentLevel}), and the folders above it are its group.
 * - `pattern`: the experiment is the folder at `{experiment}` (else `{run}`);
 *   the folders before it are its group and must match their literal segments
 *   (`*` matches any folder), else the file is loose. One folder per
 *   experiment and Experiment / run folders are the patterns `{experiment}`
 *   and `{experiment}/{run}`.
 * - `flat`: no group, no experiment, no folders (the inner path is the name).
 *
 * A file above the experiment level belongs to its group (its folders), with
 * no experiment. The inner path is the rest of the path below the experiment
 * (or group), so the list can show subfolders as a tree.
 */
export function assignRow(
  folders: string[],
  name: string,
  structure: ExperimentsStructure,
  level: number,
): { group: string | null; experiment: string | null; innerPath: string } {
  if (structure.kind === "flat") return { group: null, experiment: null, innerPath: name }
  let experimentIndex = level - 1
  if (structure.kind === "pattern") {
    const at = structure.segments.indexOf("{experiment}")
    experimentIndex = at === -1 ? structure.segments.indexOf("{run}") : at
    for (const [index, segment] of structure.segments.slice(0, experimentIndex).entries()) {
      const folderName = folders[index]
      if (folderName === undefined) break
      if (segment !== "*" && segment !== folderName) {
        return { group: null, experiment: null, innerPath: [...folders, name].join("/") }
      }
    }
  }
  const inner = (from: number): string => [...folders.slice(from), name].join("/")
  if (folders.length <= experimentIndex) {
    return {
      group: folders.length === 0 ? null : folders.join("/"),
      experiment: null,
      innerPath: name,
    }
  }
  return {
    group: experimentIndex === 0 ? null : folders.slice(0, experimentIndex).join("/"),
    experiment: folders[experimentIndex] ?? null,
    innerPath: inner(experimentIndex + 1),
  }
}

interface AnalysisArtifactCandidate {
  abs: string
  kind: DataFileKind
}

/**
 * Whitelist-aware visitor over the shared breadth-first walker, over the whole
 * folder. A `.zarr` directory is collected and pruned.
 */
async function walkAnalysisArtifacts(
  repoPath: string,
): Promise<{ artifacts: AnalysisArtifactCandidate[]; skipped: string[] }> {
  const artifacts: AnalysisArtifactCandidate[] = []
  const result = await walkWorkspace(
    repoPath,
    { ignore: EXTRA_IGNORED_DIRS, includeHidden: false },
    async (entry) => {
      if (entry.kind === "dir") {
        const kind = classifyAnalysisArtifact(entry.name, "directory")
        if (kind !== null) {
          artifacts.push({ abs: entry.path, kind })
          return "prune"
        }
        return "continue"
      }
      let kind = classifyAnalysisArtifact(entry.name, "file")
      if (kind === null && extname(entry.name).toLowerCase() === ".py") {
        kind = (await isMarimoNotebookFile(entry.path)) ? "marimo" : null
      }
      if (kind !== null) artifacts.push({ abs: entry.path, kind })
      return "continue"
    },
  )
  return { artifacts, skipped: result.skipped }
}

/** Expected child failures report a partial listing; other failures surface. */
function isExpectedChildError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["EACCES", "EPERM", "ENOENT"].includes(String(error.code))
  )
}

/** Read only a bounded prefix and positively identify a marimo notebook. */
export async function isMarimoNotebookFile(abs: string): Promise<boolean> {
  const file = await open(abs, "r")
  try {
    const buffer = Buffer.allocUnsafe(MAX_MARIMO_SOURCE_BYTES + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const inspectedBytes = Math.min(bytesRead, MAX_MARIMO_SOURCE_BYTES)
    return isMarimoNotebookSource(buffer.subarray(0, inspectedBytes).toString("utf8"))
  } finally {
    await file.close()
  }
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

  // A marimo notebook is a `.py` file: show its source.
  if (extname(relPath).toLowerCase() === ".py" && (await isMarimoNotebookFile(abs))) {
    return previewText(abs)
  }

  switch (kind) {
    case "notebook":
      if (info.size > MAX_NOTEBOOK_BYTES) return meta("Notebook too large to preview")
      return { type: "notebook", ...parseIpynb(await readFile(abs, "utf8")) }
    case "csv":
    case "tsv":
      return previewTable(abs, kind === "tsv" ? "\t" : ",", meta)
    case "json":
      return previewJson(abs, meta)
    case "image":
      return previewImage(abs, relPath, info.size, meta)
    case "markdown":
    case "markup":
    case "text":
      return previewText(abs)
    case "npy":
      return previewNpy(abs, relPath, info.size, meta)
    default:
      // Binary stores (including pickle), reports, plots, and Zarr
      // directories are intentionally metadata-only: never deserialize or read.
      // PDFs render in the renderer's PDF.js viewer (`analysis.pdf`).
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

/** Missing cells remain missing; a literal zero remains a measurement. */
function numericCell(cell: string | undefined): number | null {
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
  /** Array shape: `[n]` for 1-D, `[rows, cols]` for 2-D. */
  shape: number[]
  /** Original dtype descr (e.g. `<f8`). */
  dtype: string
  /** Read one logical cell directly from its source bytes. */
  readValue: (row: number, col: number) => number
}

/** Parse the `.npy` header dict text into descr / fortran_order / shape. */
function parseNpyHeader(
  header: string,
): { descr: string; fortranOrder: boolean; shape: number[] } | null {
  const descr = header.match(/'descr'\s*:\s*'([^']+)'/)
  const fortran = header.match(/'fortran_order'\s*:\s*(True|False)/)
  const shapeText = header.match(/'shape'\s*:\s*\(([^)]*)\)/)
  if (!descr || !fortran || !shapeText) return null
  const rawShape = (shapeText[1] ?? "").trim()
  if (rawShape === "")
    return { descr: descr[1] ?? "", fortranOrder: fortran[1] === "True", shape: [] }
  const firstComma = rawShape.indexOf(",")
  if (firstComma < 0) return null
  const secondComma = rawShape.indexOf(",", firstComma + 1)
  if (secondComma >= 0 && rawShape.slice(secondComma + 1).trim() !== "") return null
  const first = rawShape.slice(0, firstComma).trim()
  const second = rawShape.slice(firstComma + 1, secondComma >= 0 ? secondComma : undefined).trim()
  if (secondComma >= 0 && second === "") return null
  if (!/^\d+$/.test(first) || (second !== "" && !/^\d+$/.test(second))) return null
  const shape = second === "" ? [Number(first)] : [Number(first), Number(second)]
  if (!shape.every((dimension) => Number.isSafeInteger(dimension) && dimension >= 0)) return null
  return { descr: descr[1] ?? "", fortranOrder: fortran[1] === "True", shape }
}

/**
 * Decode a `.npy` header into a 1-D/2-D numeric source accessor. Any
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
  const minor = buf[7]
  let headerLen: number
  let headerStart: number
  if (major === 1 && minor === 0) {
    headerLen = view.getUint16(8, true)
    headerStart = 10
  } else if ((major === 2 || major === 3) && minor === 0) {
    if (buf.length < 12) return null
    headerLen = view.getUint32(8, true)
    headerStart = 12
  } else {
    return null
  }

  const dataOffset = headerStart + headerLen
  if (!Number.isSafeInteger(dataOffset) || dataOffset > buf.length) return null
  const header = buf.toString("utf8", headerStart, dataOffset)
  const parsed = parseNpyHeader(header)
  if (!parsed) return null
  // Only 1-D / 2-D numeric arrays are renderable; scalars and N-D arrays fall back.
  if (parsed.shape.length === 0 || parsed.shape.length > 2) return null

  const marker = parsed.descr[0]
  if (marker !== "<" && marker !== ">" && marker !== "|" && marker !== "=") return null
  const littleEndian =
    marker === "<" ||
    marker === "|" ||
    (marker === "=" && new Uint8Array(new Uint16Array([1]).buffer)[0] === 1)
  const dtype = NPY_DTYPES[parsed.descr.slice(1)]
  if (!dtype) return null

  let total = 1
  for (const dimension of parsed.shape) {
    total *= dimension
    if (!Number.isSafeInteger(total)) return null
  }
  const byteCount = total * dtype.width
  if (!Number.isSafeInteger(byteCount) || byteCount > buf.length - dataOffset) return null

  const [rowCount = 0, colCount = 1] = parsed.shape
  const readValue = (row: number, col: number): number => {
    const index =
      parsed.fortranOrder && parsed.shape.length === 2 ? col * rowCount + row : row * colCount + col
    return dtype.read(view, dataOffset + index * dtype.width, littleEndian)
  }
  return { readValue, shape: parsed.shape, dtype: parsed.descr }
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
  const file = await open(abs, "r")
  let source = Buffer.allocUnsafe(Math.min(MAX_NPY_BYTES + 1, Math.max(4096, size + 1)))
  let length = 0
  try {
    while (length < MAX_NPY_BYTES + 1) {
      if (length === source.length) {
        const grown = Buffer.allocUnsafe(Math.min(MAX_NPY_BYTES + 1, source.length * 2))
        source.copy(grown, 0, 0, length)
        source = grown
      }
      const result = await file.read(source, length, source.length - length, length)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
  } finally {
    await file.close()
  }
  if (length > MAX_NPY_BYTES) return meta("Array too large to decode inline")
  const decoded = decodeNpy(source.subarray(0, length))
  if (!decoded) return meta("Could not decode .npy array")

  if (decoded.shape.length === 1) return npyChart(decoded, relPath)
  return npyArray(decoded)
}

/** A 1-D `.npy` array → a single-series line chart over its row index. */
function npyChart(decoded: DecodedNpy, relPath: string): ChartPreview {
  const label = baseNameWithoutExt(relPath)
  const count = decoded.shape[0] ?? 0
  const truncated = count > MAX_CHART_POINTS
  const stride = truncated ? Math.ceil(count / MAX_CHART_POINTS) : 1
  const x: number[] = []
  const values: Array<number | null> = []
  for (let row = 0; row < count; row += stride) {
    x.push(row)
    const value = decoded.readValue(row, 0)
    values.push(Number.isFinite(value) ? value : null)
  }
  return { type: "chart", xLabel: "index", x, series: [{ label, values }], truncated }
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
    for (let c = 0; c < shownCols; c++) row.push(formatCell(decoded.readValue(r, c)))
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
