import { open, readFile, stat } from "node:fs/promises"
import { extname, join, relative } from "node:path"
import {
  ALL_DATA_FILE_KINDS,
  classifyAnalysisArtifact,
  classifyDataFile,
  type DataFileKind,
  isMarimoNotebookSource,
} from "@pi-lab/shared"
import { parseIpynb } from "@pi-lab/shared/analysis/ipynb"
import { walkWorkspace } from "@pi-lab/workspace-fs"
import { TRPCError } from "@trpc/server"
import { previewHdf5, readHdf5Frame } from "./hdf5"
import { fileReader, previewNpyBytes } from "./npy"
import { previewNpz } from "./npz"
import { previewParquet, readParquetFrame } from "./parquet"
import {
  type ChartSpec,
  type DataFilePreview,
  HUGE_FILE_BYTES,
  LARGE_FILE_BYTES,
  MAX_FRAME_BYTES,
  MAX_FRAME_ROWS,
  MAX_IMAGE_BYTES,
  MAX_NOTEBOOK_BYTES,
  MAX_TABLE_ROWS,
  MAX_TEXT_BYTES,
  type MetadataPreview,
  type PlotPreview,
  type TableOps,
  type TablePage,
  type TextPreview,
} from "./previewShapes"
import { pickleFrame, previewPickle } from "./pythonPreview"
import { previewSqlite, readSqliteFrame } from "./sqlite"
import type { ExperimentsStructure } from "./structure"
import { applyOps, csvOf, type OpsResult, pageOf } from "./tableOps"
import { buildPlot, type Frame, readDelimitedFrame, tableFromFrame } from "./tables"

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
   * The folder path above the experiment (e.g. `group_b`), shown as
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
 * cannot hide other experiments; the Folders structure has no cap. `.zarr` directories are
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
    // Folders shows the plain tree, so it lists every file: no per-row cap.
    const capped = !(structure.kind === "folders" && folder === "results")
    const key = `${row.group ?? ""}\u0000${row.experiment ?? ""}`
    const kept = keptPerExperiment.get(key) ?? 0
    if (capped && kept >= MAX_LISTED_FILES) {
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
 * - `folders`: no group, no experiment; every file is loose and its inner path
 *   is its whole path under the results folder (the list shows the real tree).
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
  if (structure.kind === "folders") {
    return { group: null, experiment: null, innerPath: [...folders, name].join("/") }
  }
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

export * from "./previewShapes"

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
export async function previewDataFile(
  abs: string,
  relPath: string,
  options: PreviewOptions,
): Promise<DataFilePreview> {
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

  if (!options.load && info.isFile() && info.size > HUGE_FILE_BYTES) {
    return {
      type: "large",
      kind,
      size: info.size,
      huge: true,
      partial: await hugeFilePartial(abs, relPath, options.dataset, meta),
    }
  }

  const ext = extname(relPath).toLowerCase()
  const reader = READER_BY_EXT[ext]
  if (reader) {
    const limit = LARGE_FILE_BYTES[reader]
    if (!options.load && limit !== null && info.size > limit)
      return { type: "large", kind, size: info.size, huge: false, partial: null }
    if (reader === "pickle") return previewPickleFile(abs, relPath, meta)
    if (reader === "hdf5") return previewHdf5(abs, options.dataset, meta)
    if (reader === "sqlite") return previewSqlite(abs, options.dataset, meta)
    return previewParquet(abs, info.size, options.load, meta)
  }

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
      return previewTable(abs, kind === "tsv" ? "\t" : ",", MAX_FRAME_BYTES, meta)
    case "json":
      return previewJson(abs, meta)
    case "image":
      return previewImage(abs, relPath, info.size, meta)
    case "markdown":
    case "markup":
    case "text":
      return previewText(abs)
    case "npy":
      return previewNpy(abs, relPath, info.size, options.load, meta)
    case "npz":
      return previewNpz(abs, info.size, options.dataset, options.load, meta)
    default:
      // Other binary stores, reports, plots, and Zarr directories are
      // metadata-only. PDFs render in the renderer's PDF.js viewer (`analysis.pdf`).
      return meta()
  }
}

/**
 * The part of a file over {@link HUGE_FILE_BYTES} that is safe to show
 * before the user loads it: a CSV/TSV's or Parquet file's first rows, a text
 * head, an HDF5 file's datasets (h5wasm reads only what is shown), a SQLite
 * file's tables (SQLite reads by page, so only what is shown), a numeric
 * `.npy` (only the shown cells), a `.npz` file's arrays (and the chosen one
 * unless it must be decompressed whole above 32 MiB). Pickles, which are read
 * whole, show nothing.
 */
export async function hugeFilePartial(
  abs: string,
  relPath: string,
  dataset: string | null,
  meta: (note?: string) => MetadataPreview,
): Promise<DataFilePreview | null> {
  const kind = classifyDataFile(relPath)
  const reader = READER_BY_EXT[extname(relPath).toLowerCase()]
  if (reader === "parquet") {
    const read = await readParquetFrame(abs, false, MAX_TABLE_ROWS)
    return read.kind === "frame" ? tableFromFrame(read.frame) : null
  }
  if (reader === "hdf5") return previewHdf5(abs, dataset, meta)
  if (reader === "sqlite") return previewSqlite(abs, dataset, meta)
  if (reader === "pickle") return null
  if (kind === "csv" || kind === "tsv") {
    return previewTable(abs, kind === "tsv" ? "\t" : ",", MAX_TEXT_BYTES, meta)
  }
  if (kind === "markdown" || kind === "markup" || kind === "text") return previewText(abs)
  if (kind === "npy") {
    // Numeric arrays read only the header and the shown cells; object arrays are pickles.
    const { size } = await stat(abs)
    const preview = await previewNpy(abs, relPath, size, false, meta)
    return preview.type === "large" ? null : preview
  }
  if (kind === "npz") {
    // Only the zip directory, the array headers and the chosen array are read.
    const { size } = await stat(abs)
    const preview = await previewNpz(abs, size, dataset, false, meta)
    return preview.type === "large" ? preview.partial : preview
  }
  return null
}

/** What a chart request asks for besides the file. */
export interface ChartOptions {
  /** The HDF5 dataset or SQLite table holding the table, or null for other formats. */
  dataset: string | null
  /** What is done to the table before it is plotted. */
  ops: TableOps
  spec: ChartSpec
}

/** What a table page request asks for besides the file. */
export interface TablePageOptions {
  dataset: string | null
  ops: TableOps
  offset: number
  limit: number
}

/**
 * Plot a table file (CSV/TSV, Parquet, a pickled DataFrame or list of dicts,
 * an HDF5 compound dataset, a SQLite table or view) after its table
 * operations, with the chart builder's settings.
 */
export async function chartDataFile(
  abs: string,
  relPath: string,
  options: ChartOptions,
): Promise<PlotPreview> {
  const result = await opsResultOf(abs, relPath, options.dataset, options.ops)
  const plot = buildPlot(result.frame, options.spec)
  return { ...plot, notes: [...result.notes, ...plot.notes] }
}

/** Rows of a table file after its table operations, one page at a time. */
export async function tableDataFile(
  abs: string,
  relPath: string,
  options: TablePageOptions,
): Promise<TablePage> {
  const result = await opsResultOf(abs, relPath, options.dataset, options.ops)
  return pageOf(result, options.offset, options.limit)
}

/** A table file after its table operations, as CSV text (for Export CSV). */
export async function csvOfDataFile(
  abs: string,
  relPath: string,
  options: { dataset: string | null; ops: TableOps; columns: string[] | null },
): Promise<{ csv: string; rows: number }> {
  const result = await opsResultOf(abs, relPath, options.dataset, options.ops)
  return { csv: csvOf(result.frame, options.columns), rows: result.frame.rowCount }
}

/**
 * The first {@link MAX_FRAME_ROWS} rows of a table file after `ops`. The last
 * table read and the last result are kept for the next request on the same
 * unchanged file, so paging and changing settings are quick.
 */
async function opsResultOf(
  abs: string,
  relPath: string,
  dataset: string | null,
  ops: TableOps,
): Promise<OpsResult> {
  const info = await stat(abs).catch(() => {
    throw new TRPCError({ code: "NOT_FOUND", message: `No file ${relPath}` })
  })
  const key = [abs, dataset ?? "", info.size, info.mtimeMs].join("\0")
  if (frameCache?.key !== key) {
    frameCache = null
    resultCache = null
    frameCache = { key, frame: await readTableFrame(abs, relPath, dataset) }
  }
  const resultKey = `${key}\0${JSON.stringify(ops)}`
  if (resultCache?.key !== resultKey) {
    resultCache = { key: resultKey, result: applyOps(frameCache.frame, ops) }
  }
  return resultCache.result
}

/** The last table read by {@link opsResultOf}, keyed by path, dataset, size and time. */
let frameCache: { key: string; frame: Frame } | null = null
/** The last result of table operations, keyed by the table and the operations. */
let resultCache: { key: string; result: OpsResult } | null = null

/** Read a table file into a frame; a file that holds no table is a BAD_REQUEST. */
async function readTableFrame(
  abs: string,
  relPath: string,
  dataset: string | null,
): Promise<Frame> {
  const notTable = (why: string) =>
    new TRPCError({ code: "BAD_REQUEST", message: `${relPath}: ${why}` })
  const reader = READER_BY_EXT[extname(relPath).toLowerCase()]
  if (reader === "pickle") return pickleFrame(await readFile(abs))
  if (reader === "hdf5") {
    if (dataset === null) throw notTable("choose a dataset")
    return readHdf5Frame(abs, dataset)
  }
  if (reader === "sqlite") {
    if (dataset === null) throw notTable("choose a table")
    return readSqliteFrame(abs, dataset)
  }
  if (reader === "parquet") {
    const read = await readParquetFrame(abs, true, MAX_FRAME_ROWS)
    if (read.kind !== "frame") throw notTable(read.kind === "note" ? read.note : "not read")
    return read.frame
  }
  const kind = classifyDataFile(relPath)
  if (kind === "csv" || kind === "tsv") {
    const frame = await readDelimitedFrame(abs, kind === "tsv" ? "\t" : ",", MAX_FRAME_BYTES)
    if (!frame) throw notTable("the file is empty")
    return frame
  }
  throw notTable("not a table")
}

/** What a preview request asks for besides the file. */
export interface PreviewOptions {
  /** Read the file even when it is above its format's {@link LARGE_FILE_BYTES}. */
  load: boolean
  /** The HDF5 dataset or SQLite table to preview, or null for the first one. */
  dataset: string | null
}

/** The extensions with their own reader, keyed to {@link LARGE_FILE_BYTES}. */
const READER_BY_EXT: Readonly<Record<string, keyof typeof LARGE_FILE_BYTES>> = {
  ".pkl": "pickle",
  ".pickle": "pickle",
  ".h5": "hdf5",
  ".hdf5": "hdf5",
  ".parquet": "parquet",
  ".pq": "parquet",
  ".db": "sqlite",
  ".sqlite": "sqlite",
  ".sqlite3": "sqlite",
}

/** Read a whole `.pkl` with the safe unpickler. */
async function previewPickleFile(
  abs: string,
  relPath: string,
  meta: (note?: string) => MetadataPreview,
): Promise<DataFilePreview> {
  return previewPickle(await readFile(abs), baseNameWithoutExt(relPath), meta)
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

/** A CSV/TSV as a table (see `tables.ts`); `maxBytes` bounds the read. */
async function previewTable(
  abs: string,
  delimiter: string,
  maxBytes: number,
  meta: (note?: string) => MetadataPreview,
): Promise<DataFilePreview> {
  const frame = await readDelimitedFrame(abs, delimiter, maxBytes)
  if (!frame) return meta("Empty file")
  return tableFromFrame(frame)
}

// ── NumPy (.npy) ─────────────────────────────────────────────────────────────

/** Preview a `.npy` file (see {@link previewNpyBytes}); only what is shown is read. */
async function previewNpy(
  abs: string,
  relPath: string,
  size: number,
  load: boolean,
  meta: (note?: string) => MetadataPreview,
): Promise<DataFilePreview> {
  const file = await open(abs, "r")
  try {
    return await previewNpyBytes(fileReader(file), size, baseNameWithoutExt(relPath), load, meta)
  } finally {
    await file.close()
  }
}

/** A byte count as `12.3 MB` (decimal megabytes). */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`
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
