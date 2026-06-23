import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

/** A single entry produced when listing a directory's immediate children. */
export interface DirEntry {
  /** The entry's own name (no path components). */
  name: string
  /** Absolute path to the entry. */
  path: string
  /** Whether the entry is a regular file or a directory. */
  kind: "file" | "dir"
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
 * Directory names that are noise for a research/source workspace and are always
 * excluded from walks. Callers can extend this set via {@link WalkOptions.ignore}.
 */
export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  ".git",
  "node_modules",
  ".turbo",
  "dist",
  ".cache",
]

/** A file's identity-on-disk fingerprint, used to detect out-of-band edits. */
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
    entries.push({ name: dirent.name, path: join(absPath, dirent.name), kind })
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
  const ignored = new Set([...DEFAULT_IGNORED_DIRS, ...(opts.ignore ?? [])])
  const limit = opts.limit ?? Number.POSITIVE_INFINITY
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY

  const files: string[] = []
  let frontier: string[] = [root]
  let depth = 0

  while (frontier.length > 0 && depth <= maxDepth && files.length < limit) {
    const next: string[] = []
    for (const dir of frontier) {
      const dirents = await readdir(dir, { withFileTypes: true })
      for (const dirent of dirents) {
        if (dirent.isFile()) {
          files.push(join(dir, dirent.name))
          if (files.length >= limit) return files
        } else if (dirent.isDirectory() && !ignored.has(dirent.name)) {
          next.push(join(dir, dirent.name))
        }
      }
    }
    frontier = next
    depth += 1
  }

  return files
}

/** Directories before files, then case-insensitive name order. */
function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
  return a.name.localeCompare(b.name)
}
