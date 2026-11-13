import { type FileHandle, open, readFile, stat } from "node:fs/promises"
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
import { previewHdf5 } from "./hdf5"
import { previewParquet } from "./parquet"
import {
  type ArrayPreview,
  type ChartPreview,
  type DataFilePreview,
  detectScalarChart,
  formatCell,
  LARGE_FILE_BYTES,
  MAX_ARRAY_COLS,
  MAX_ARRAY_ROWS,
  MAX_CHART_POINTS,
  MAX_IMAGE_BYTES,
  MAX_NOTEBOOK_BYTES,
  MAX_PICKLE_BYTES,
  MAX_TABLE_ROWS,
  MAX_TEXT_BYTES,
  type MetadataPreview,
  type TextPreview,
} from "./previewShapes"
import { previewPickle } from "./pythonPreview"
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
    // Folders: the cap applies to each top-level folder, not the whole results folder.
    const key =
      structure.kind === "folders" && folder === "results"
        ? `\u0001${folders[0] ?? ""}`
        : `${row.group ?? ""}\u0000${row.experiment ?? ""}`
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

  const ext = extname(relPath).toLowerCase()
  const reader = READER_BY_EXT[ext]
  if (reader) {
    const limit = LARGE_FILE_BYTES[reader]
    if (!options.load && limit !== null && info.size > limit)
      return { type: "large", kind, size: info.size }
    if (reader === "pickle") return previewPickleFile(abs, relPath, info.size, meta)
    if (reader === "hdf5") return previewHdf5(abs, options.dataset, meta)
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
      return previewNpy(abs, relPath, info.size, options.load, meta)
    default:
      // Other binary stores, reports, plots, and Zarr directories are
      // metadata-only. PDFs render in the renderer's PDF.js viewer (`analysis.pdf`).
      return meta()
  }
}

/** What a preview request asks for besides the file. */
export interface PreviewOptions {
  /** Read the file even when it is above its format's {@link LARGE_FILE_BYTES}. */
  load: boolean
  /** The HDF5 dataset to preview, or null for the first one. */
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
}

/** Read a whole `.pkl` (up to {@link MAX_PICKLE_BYTES}) with the safe unpickler. */
async function previewPickleFile(
  abs: string,
  relPath: string,
  size: number,
  meta: (note?: string) => MetadataPreview,
): Promise<DataFilePreview> {
  if (size > MAX_PICKLE_BYTES) {
    return meta(`Stores Python objects; too large to read (${formatMegabytes(size)})`)
  }
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

/** A `.npy` file's header fields and where its data starts. */
interface NpyHeader {
  descr: string
  fortranOrder: boolean
  /** `[n]` or `[rows, cols]` (higher ranks are refused by the parser). */
  shape: number[]
  /** Byte offset of the first data byte. */
  dataOffset: number
}

/** A 1-D/2-D numeric `.npy` source whose shown cells were read from disk. */
interface DecodedNpy {
  /** Array shape: `[n]` for 1-D, `[rows, cols]` for 2-D. */
  shape: number[]
  /** Original dtype descr (e.g. `<f8`). */
  dtype: string
  /** Read one shown logical cell. */
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
 * Parse the magic, version and header dict of a `.npy` prefix. Returns null
 * for a bad magic, an unsupported version, a header past the end of `buf`, or
 * a header the parser refuses (see {@link parseNpyHeader}).
 *
 * Format spec: https://numpy.org/doc/stable/reference/generated/numpy.lib.format.html
 */
function parseNpyPrefix(buf: Buffer): NpyHeader | null {
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
  const parsed = parseNpyHeader(buf.toString("utf8", headerStart, dataOffset))
  return parsed ? { ...parsed, dataOffset } : null
}

/** Max bytes read for a `.npy` header (longer headers fall back to metadata). */
const MAX_NPY_HEADER_BYTES = 1024 * 1024

/**
 * Preview a `.npy` array, reading only what is shown. A 1-D numeric array
 * becomes a {@link ChartPreview} (value vs. row index, strided to
 * {@link MAX_CHART_POINTS}); a 2-D one a bounded {@link ArrayPreview} grid.
 * Only the header and the shown cells are read from disk, so the file size
 * does not matter. An object array (`|O`) holds a pickle, read whole (up to
 * {@link MAX_PICKLE_BYTES}, and above the pickle size limit only with `load`)
 * by the safe unpickler. Anything malformed or
 * unsupported degrades to a metadata card with a note (no throw).
 */
async function previewNpy(
  abs: string,
  relPath: string,
  size: number,
  load: boolean,
  meta: (note?: string) => MetadataPreview,
): Promise<DataFilePreview> {
  const file = await open(abs, "r")
  try {
    const head = await readAt(file, 0, Math.min(size, MAX_NPY_HEADER_BYTES))
    const header = parseNpyPrefix(head)
    if (!header) return meta("Could not decode .npy array")
    if (/^[|<>=]O\d*$/.test(header.descr)) {
      const limit = LARGE_FILE_BYTES.pickle
      if (!load && limit !== null && size > limit) return { type: "large", kind: "npy", size }
      if (size > MAX_PICKLE_BYTES) {
        return meta(`Stores Python objects; too large to read (${formatMegabytes(size)})`)
      }
      const payload = await readAt(file, header.dataOffset, size - header.dataOffset)
      return previewPickle(payload, baseNameWithoutExt(relPath), meta)
    }
    const decoded = await readNpyCells(file, header, size)
    if (!decoded) return meta("Could not decode .npy array")
    if (decoded.shape.length === 1) return npyChart(decoded, relPath)
    return npyArray(decoded)
  } finally {
    await file.close()
  }
}

/** Read `length` bytes at `position` (fewer if the file is shorter). */
async function readAt(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, length))
  let done = 0
  while (done < buffer.length) {
    const { bytesRead } = await file.read(buffer, done, buffer.length - done, position + done)
    if (bytesRead === 0) break
    done += bytesRead
  }
  return buffer.subarray(0, done)
}

/** Bytes between two shown cells below which one read covers both. */
const NPY_READ_GAP = 4096

/**
 * Read the cells a preview shows (a strided series, or the top-left grid) of
 * a numeric 1-D/2-D array. Null when the dtype is unsupported, the shape is a
 * scalar, or the file is shorter than the header says.
 */
async function readNpyCells(
  file: FileHandle,
  header: NpyHeader,
  size: number,
): Promise<DecodedNpy | null> {
  if (header.shape.length === 0 || header.shape.length > 2) return null
  const marker = header.descr[0]
  if (marker !== "<" && marker !== ">" && marker !== "|" && marker !== "=") return null
  const littleEndian =
    marker === "<" ||
    marker === "|" ||
    (marker === "=" && new Uint8Array(new Uint16Array([1]).buffer)[0] === 1)
  const dtype = NPY_DTYPES[header.descr.slice(1)]
  if (!dtype) return null
  let total = 1
  for (const dimension of header.shape) {
    total *= dimension
    if (!Number.isSafeInteger(total)) return null
  }
  const byteCount = total * dtype.width
  if (!Number.isSafeInteger(byteCount) || byteCount > size - header.dataOffset) return null

  const [rowCount = 0, colCount = 1] = header.shape
  const storageIndex = (row: number, col: number): number =>
    header.fortranOrder && header.shape.length === 2 ? col * rowCount + row : row * colCount + col
  const wanted: number[] = []
  if (header.shape.length === 1) {
    for (let row = 0; row < rowCount; row += chartStride(rowCount)) wanted.push(row)
  } else {
    const shownRows = Math.min(rowCount, MAX_ARRAY_ROWS)
    const shownCols = Math.min(colCount, MAX_ARRAY_COLS)
    for (let row = 0; row < shownRows; row++) {
      for (let col = 0; col < shownCols; col++) wanted.push(storageIndex(row, col))
    }
    wanted.sort((a, b) => a - b)
  }

  const values = new Map<number, number>()
  let start = 0
  while (start < wanted.length) {
    let end = start
    while (
      end + 1 < wanted.length &&
      ((wanted[end + 1] ?? 0) - (wanted[end] ?? 0)) * dtype.width <= NPY_READ_GAP
    ) {
      end++
    }
    const first = wanted[start] ?? 0
    const last = wanted[end] ?? 0
    const bytes = await readAt(
      file,
      header.dataOffset + first * dtype.width,
      (last - first + 1) * dtype.width,
    )
    if (bytes.length < (last - first + 1) * dtype.width) return null
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let i = start; i <= end; i++) {
      const index = wanted[i] ?? 0
      values.set(index, dtype.read(view, (index - first) * dtype.width, littleEndian))
    }
    start = end + 1
  }
  return {
    shape: header.shape,
    dtype: header.descr,
    readValue: (row, col) => values.get(storageIndex(row, col)) ?? Number.NaN,
  }
}

/** The stride that brings `count` points down to at most {@link MAX_CHART_POINTS}. */
function chartStride(count: number): number {
  return count > MAX_CHART_POINTS ? Math.ceil(count / MAX_CHART_POINTS) : 1
}

/** A 1-D `.npy` array → a single-series line chart over its row index. */
function npyChart(decoded: DecodedNpy, relPath: string): ChartPreview {
  const label = baseNameWithoutExt(relPath)
  const count = decoded.shape[0] ?? 0
  const stride = chartStride(count)
  const x: number[] = []
  const values: Array<number | null> = []
  for (let row = 0; row < count; row += stride) {
    x.push(row)
    const value = decoded.readValue(row, 0)
    values.push(Number.isFinite(value) ? value : null)
  }
  return { type: "chart", xLabel: "index", x, series: [{ label, values }], truncated: stride > 1 }
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
