import { isUtf8 } from "node:buffer"
import type { Stats } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { walkWorkspace } from "./walk"

export { DEFAULT_IGNORED_DIRS } from "./walk"

/** A single entry produced when listing a directory's immediate children. */
export interface DirEntry {
  /** The entry's own name (no path components). */
  name: string
  /** Absolute path to the entry. */
  path: string
  /** Whether the entry is a regular file or a directory. */
  kind: "file" | "dir"
  /** Last-modified time as epoch milliseconds, for renderer-side sorting. */
  mtimeMs: number
}

/** Options that shape a recursive walk of a workspace tree. */
export interface WalkOptions {
  /**
   * Directory names to skip entirely (matched on the entry name, not the full
   * path). Always merged with {@link DEFAULT_IGNORED_DIRS}.
   */
  ignore?: string[]
  /**
   * How deep to descend. `0` yields only files in `root` itself; omitted means
   * unlimited depth.
   */
  maxDepth?: number
  /** Stop collecting once this many files have been gathered. */
  limit?: number
}

/**
 * A file's identity-on-disk fingerprint, used to detect out-of-band edits.
 */
export interface FileStat {
  /** Whether the path exists. `false` ⇒ the other fields are zero. */
  exists: boolean
  /** Last-modified time as epoch milliseconds. */
  mtimeMs: number
  /** Size in bytes. */
  size: number
}

/** Read a file as UTF-8 text. */
export async function readTextFile(absPath: string): Promise<string> {
  return readFile(absPath, "utf8")
}

/** Maximum UTF-8 bytes accepted by editor and document-panel reads. */
export const EDITOR_MAX_BYTES = 10_000_000

/** Rejected reads carry metadata only, never truncated editable content. */
export type TextSnapshot =
  | { status: "text"; exists: true; content: string; baseline: FileStat }
  | { status: "missing"; exists: false; content: ""; baseline: FileStat }
  | { status: "oversized"; exists: true; size: number; limit: number; baseline: FileStat }
  | { status: "binary"; exists: true; size: number; baseline: FileStat }

/** Read one stable version with bounded allocation, retrying changes and replacements. */
export async function readTextSnapshot(absPath: string): Promise<TextSnapshot> {
  const snapshot = await stableFileRead(absPath, async (handle, before) => {
    if (before.size > EDITOR_MAX_BYTES) return { status: "oversized" as const }
    const bytes = Buffer.allocUnsafe(Math.min(before.size + 1, EDITOR_MAX_BYTES + 1))
    let used = 0
    // Never trust the pre-read size: a writer may extend this open file.
    let chunks: Buffer[] = []
    let buffer = bytes
    while (used <= EDITOR_MAX_BYTES) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      used += bytesRead
      chunks.push(buffer.subarray(0, bytesRead))
      if (used > EDITOR_MAX_BYTES) return { status: "oversized" as const }
      buffer = Buffer.allocUnsafe(Math.min(64 * 1024, EDITOR_MAX_BYTES + 1 - used))
    }
    const content = chunks.length === 1 && chunks[0] ? chunks[0] : Buffer.concat(chunks, used)
    chunks = []
    if (content.includes(0) || !isUtf8(content)) return { status: "binary" as const }
    return { status: "text" as const, content: content.toString("utf8") }
  })
  if (!snapshot) return { status: "missing", exists: false, content: "", baseline: missingStat() }
  const { result, baseline } = snapshot
  if (result.status === "oversized")
    return {
      status: "oversized",
      exists: true,
      size: baseline.size,
      limit: EDITOR_MAX_BYTES,
      baseline,
    }
  if (result.status === "binary")
    return { status: "binary", exists: true, size: baseline.size, baseline }
  return { status: "text", exists: true, content: result.content, baseline }
}

/** Verify saves in chunks, independent of the editor opening cap and without a text echo. */
export async function verifyWrittenText(
  absPath: string,
  content: string,
): Promise<{ baseline: FileStat; matchesWrittenContent: boolean }> {
  const snapshot = await stableFileRead(absPath, async (handle, before) => {
    if (before.size !== Buffer.byteLength(content, "utf8")) return false
    const actual = Buffer.allocUnsafe(64 * 1024 * 3)
    for (let start = 0; start < content.length; ) {
      let end = Math.min(start + 64 * 1024, content.length)
      // Keep a surrogate pair together when encoding each piece.
      const last = content.charCodeAt(end - 1)
      if (end < content.length && last >= 0xd800 && last <= 0xdbff) end -= 1
      const piece = content.slice(start, end)
      const expected = Buffer.from(piece, "utf8")
      if (expected.toString("utf8") !== piece) return false
      let used = 0
      while (used < expected.length) {
        const { bytesRead } = await handle.read(actual, used, expected.length - used, null)
        if (bytesRead === 0) return false
        used += bytesRead
      }
      if (!actual.subarray(0, used).equals(expected)) return false
      start = end
    }
    const { bytesRead } = await handle.read(actual, 0, 1, null)
    return bytesRead === 0
  })
  return snapshot
    ? { baseline: snapshot.baseline, matchesWrittenContent: snapshot.result }
    : { baseline: missingStat(), matchesWrittenContent: false }
}

/** Pair a bounded reader's result with a coherent handle and path fingerprint. */
async function stableFileRead<T>(
  absPath: string,
  read: (handle: FileHandle, before: Stats) => Promise<T>,
): Promise<{ result: T; baseline: FileStat } | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = await open(absPath, "r").catch((error: unknown) => {
      if (isEnoent(error)) return null
      throw error
    })
    if (!handle) return null
    try {
      const before = await handle.stat()
      if (!before.isFile()) throw new Error(`Not a regular file: ${absPath}`)
      const result = await read(handle, before)
      const after = await handle.stat()
      const current = await stat(absPath).catch((error: unknown) => {
        if (isEnoent(error)) return null
        throw error
      })
      if (current && sameFileVersion(before, after) && sameFileVersion(after, current)) {
        return { result, baseline: { exists: true, mtimeMs: after.mtimeMs, size: after.size } }
      }
    } finally {
      await handle.close()
    }
  }
  throw new Error(`File kept changing while reading: ${absPath}`)
}

/** Missing paths use the same fingerprint for reads and save verification. */
function missingStat(): FileStat {
  return { exists: false, mtimeMs: 0, size: 0 }
}

/** Include inode and change time so replacements and equal-size edits are detected. */
function sameFileVersion(first: Stats, second: Stats): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs
  )
}

/**
 * Fingerprint a file for change detection (the built-in editor polls this to
 * spot agent/git edits). A missing file is a normal answer (`exists: false`)
 * rather than an error, mirroring {@link readTextFile}'s caller expectations;
 * anything that exists but is not a regular file also reports `exists: false`.
 */
export async function statFile(absPath: string): Promise<FileStat> {
  try {
    const info = await stat(absPath)
    if (!info.isFile()) return { exists: false, mtimeMs: 0, size: 0 }
    return { exists: true, mtimeMs: info.mtimeMs, size: info.size }
  } catch (error) {
    if (isEnoent(error)) return { exists: false, mtimeMs: 0, size: 0 }
    throw error
  }
}

/** Whether an error is Node's "no such file or directory". */
function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  )
}

/**
 * Write UTF-8 text to a file, creating any missing parent directories first.
 * The mirror of {@link readTextFile}: the built-in editor and the file-backed
 * tRPC procedures use this so an agent-authored doc (e.g. `RESEARCH.md`) can be
 * created in one call even when its folder doesn't exist yet.
 */
export async function writeTextFile(absPath: string, content: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, content, "utf8")
}

/**
 * List the immediate children of a directory. Entries that are neither a
 * regular file nor a directory (sockets, symlinks, devices) are omitted, and
 * the result is sorted directories-first then by name for stable output.
 */
export async function listDir(absPath: string): Promise<DirEntry[]> {
  const dirents = await readdir(absPath, { withFileTypes: true })
  const entries: DirEntry[] = []
  for (const dirent of dirents) {
    const kind = dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : null
    if (kind === null) continue
    const path = join(absPath, dirent.name)
    const info = await stat(path)
    entries.push({ name: dirent.name, path, kind, mtimeMs: info.mtimeMs })
  }
  entries.sort(compareEntries)
  return entries
}

/**
 * Recursively collect every file under `root`, returning **absolute** paths.
 * Directories whose name appears in the ignore set are pruned (their contents
 * are never visited). Traversal is breadth-first so a `limit` yields the
 * shallowest files first, which is what a file picker wants.
 */
export async function walkFiles(root: string, opts: WalkOptions = {}): Promise<string[]> {
  const limit = opts.limit ?? Number.POSITIVE_INFINITY
  if (limit <= 0) return []
  const files: string[] = []
  const result = await walkWorkspace(
    root,
    { ignore: opts.ignore, maxDepth: opts.maxDepth },
    (entry) => {
      if (entry.kind === "file") files.push(entry.path)
      return files.length >= limit ? "stop" : "continue"
    },
  )
  if (result.partial)
    throw new Error(`Could not read workspace paths: ${result.skipped.join(", ")}`)
  return files
}

/** Directories before files, then case-insensitive name order. */
function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
  return a.name.localeCompare(b.name)
}
