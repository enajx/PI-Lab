import { readFile, stat } from "node:fs/promises"
import { extname, relative } from "node:path"
import { ALL_DATA_FILE_KINDS, classifyDataFile, type DataFileKind } from "@skipper/shared"
import { walkFiles } from "@skipper/workspace-fs"
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

/** One discovered file, tagged with its kind and lightweight metadata. */
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
 * Walk a repo and classify every data/analysis file under it. Noise directories
 * are pruned; the rest are tagged via {@link classifyDataFile}, grouped by kind
 * in canonical order, and sorted by path within each group. Pure read — never
 * throws on an unreadable file (it is simply skipped). A repo with nothing data-
 * like yields empty groups.
 */
export async function discoverDataFiles(repoPath: string): Promise<DataFileListing> {
  // Request one extra so we can tell "exactly at the cap" from "over the cap".
  const absPaths = await walkFiles(repoPath, {
    ignore: [...EXTRA_IGNORED_DIRS],
    limit: MAX_LISTED_FILES + 1,
  })

  const truncated = absPaths.length > MAX_LISTED_FILES
  const kept = truncated ? absPaths.slice(0, MAX_LISTED_FILES) : absPaths

  const entries: DataFileEntry[] = []
  for (const abs of kept) {
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
      kind: classifyDataFile(relPath),
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

export type DataFilePreview =
  | TablePreview
  | JsonPreview
  | ImagePreview
  | TextPreview
  | MetadataPreview

/** Max body rows returned for a CSV/TSV preview. */
export const MAX_TABLE_ROWS = 50
/** Max raw bytes read for a CSV/TSV / JSON / text preview. */
export const MAX_TEXT_BYTES = 512 * 1024
/** Max bytes for an inline image (over this → metadata fallback). */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
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
  if (!info.isFile()) {
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
    default:
      // parquet / notebook / plot / other — no safe inline preview in v1.
      return meta()
  }
}

/** Read at most {@link MAX_TEXT_BYTES} of a file as UTF-8, flagging a cutoff. */
async function readBoundedText(abs: string): Promise<{ text: string; truncated: boolean }> {
  const buf = await readFile(abs)
  const truncated = buf.length > MAX_TEXT_BYTES
  const slice = truncated ? buf.subarray(0, MAX_TEXT_BYTES) : buf
  return { text: slice.toString("utf8"), truncated }
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

  // Body rows = everything after the header. We sample the first MAX_TABLE_ROWS;
  // totalRows is the full count when we read the whole file, otherwise it is an
  // estimate flagged via `truncated`.
  const bodyLines = lines.slice(1)
  const sampled = bodyLines.slice(0, MAX_TABLE_ROWS).map((line) => parseDelimited(line, delimiter))
  const truncated = bytesTruncated || bodyLines.length > MAX_TABLE_ROWS

  return {
    type: "table",
    headers,
    rows: sampled,
    totalRows: bodyLines.length,
    truncated,
  }
}

// ── Small pure helpers ───────────────────────────────────────────────────────

/** Normalize native (Windows) separators to POSIX for stable relPaths. */
function toPosix(p: string): string {
  return p.replaceAll("\\", "/")
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
