import { isAbsolute, relative, resolve, sep } from "node:path"
import { type PiLabDatabase, type Workspace, workspaces } from "@pi-lab/local-db"
import {
  type FileStat,
  listDir,
  readTextFile,
  searchFiles,
  statFile,
  writeTextFile,
} from "@pi-lab/workspace-fs"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { publicProcedure, router } from "../trpc"
import { workspaceWorkingDir } from "../workspaces/workspaces"

/**
 * Files router — read/write a single text file *inside a workspace's working
 * directory*, addressed by a path relative to that dir. This is the file I/O
 * primitive the right-sidebar doc panels read through (`RESEARCH.md`,
 * `TODO.md`) and that the built-in editor reuses for save (md/engineering/architecture.md (process model)).
 *
 * Beyond read/write it exposes three editor primitives:
 *   - `stat` — a cheap fingerprint (mtime+size) the editor polls to notice
 *     out-of-band edits by agents/git and reload (clean) or warn (dirty).
 *   - `tree` — the immediate children of one directory, for a lazy file tree.
 *   - `search` — a fuzzy file-name search backing the `⌘F` quick-open palette.
 *
 * The router stays thin: it resolves the workspace's working dir, jails every
 * requested path to that dir, and delegates the real work to
 * `@pi-lab/workspace-fs`. Everything is `createCaller`-testable (md/engineering/testing-and-build.md).
 */

const readInput = z.object({
  workspaceId: z.string().min(1),
  /** Path relative to the workspace's working directory (POSIX or native sep). */
  relPath: z.string().min(1),
})

const writeInput = readInput.extend({
  content: z.string(),
})

/**
 * Directory listing input. `relPath` is omitted/empty for the workspace root so
 * the tree can open at the top without a special-case caller path.
 */
const treeInput = z.object({
  workspaceId: z.string().min(1),
  /** Directory to list, relative to the working dir. Empty/omitted ⇒ the root. */
  relPath: z.string().default(""),
})

const searchInput = z.object({
  workspaceId: z.string().min(1),
  /** Fuzzy query against each file's path relative to the working dir. */
  query: z.string(),
  /** Cap on returned hits (the palette only shows a handful). */
  limit: z.number().int().positive().max(200).default(50),
})

/** A file's contents plus whether it existed (so panels can show empty states). */
export interface FileReadResult {
  /** Whether the file existed; `false` ⇒ `content` is "". */
  exists: boolean
  content: string
}

/** One entry in a directory listing, addressed relative to the working dir. */
export interface FileTreeEntry {
  /** The entry's own name (no path components). */
  name: string
  /** Path relative to the workspace working dir, POSIX-separated. */
  relPath: string
  kind: "file" | "dir"
}

/** A ranked quick-open hit, addressed relative to the working dir. */
export interface FileSearchHit {
  /** Path relative to the workspace working dir, POSIX-separated. */
  relPath: string
  /** Fuzzy score (higher is better). */
  score: number
}

/** Fetch a workspace row or throw a clean NOT_FOUND. */
function requireWorkspace(db: PiLabDatabase, workspaceId: string): Workspace {
  const row = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get()
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: `No workspace ${workspaceId}` })
  }
  return row
}

/**
 * Resolve `relPath` against a workspace's working `dir`, guaranteeing the result
 * stays *inside* `dir` (md/engineering/architecture.md (process model) — guard against path traversal). Absolute
 * inputs and any `..` escape (or a symlink-free `../outside`) are rejected with
 * a FORBIDDEN error rather than silently reading arbitrary disk.
 *
 * Kept pure (path math only, no I/O) so the jailing rule is unit-testable in
 * isolation from the filesystem.
 */
export function resolveInsideDir(dir: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Path must be relative to the workspace: ${relPath}`,
    })
  }

  const base = resolve(dir)
  const target = resolve(base, relPath)
  const rel = relative(base, target)

  // `rel` escapes the base iff it starts with ".." (a leading `..` segment) or
  // is itself absolute (different drive on Windows). An empty `rel` means the
  // path resolved to the base dir itself, which is also not a file to read.
  const escapes = rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  if (escapes) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Path escapes the workspace directory: ${relPath}`,
    })
  }

  return target
}

export const filesRouter = router({
  /**
   * Read a text file inside the workspace's working dir. A missing file is a
   * normal, expected answer (`exists: false`, empty content) so doc panels can
   * render an empty state without treating absence as an error. Any other I/O
   * failure (e.g. a directory, permissions) still surfaces as an error.
   */
  read: publicProcedure.input(readInput).query(async ({ ctx, input }): Promise<FileReadResult> => {
    const workspace = requireWorkspace(ctx.db, input.workspaceId)
    const dir = workspaceWorkingDir(ctx.db, workspace)
    const target = resolveInsideDir(dir, input.relPath)
    try {
      return { exists: true, content: await readTextFile(target) }
    } catch (error) {
      if (isNotFound(error)) return { exists: false, content: "" }
      throw error
    }
  }),

  /**
   * Write a text file inside the workspace's working dir, creating parent
   * directories as needed (the built-in editor's save path). Returns the byte
   * length written so callers can confirm the round-trip.
   */
  write: publicProcedure
    .input(writeInput)
    .mutation(async ({ ctx, input }): Promise<{ bytes: number }> => {
      const workspace = requireWorkspace(ctx.db, input.workspaceId)
      const dir = workspaceWorkingDir(ctx.db, workspace)
      const target = resolveInsideDir(dir, input.relPath)
      await writeTextFile(target, input.content)
      return { bytes: Buffer.byteLength(input.content, "utf8") }
    }),

  /**
   * Fingerprint a file (mtime + size) without reading its bytes. The editor
   * polls this to detect agent/git edits on disk: a clean buffer auto-reloads,
   * a dirty buffer warns (AGENTS.md "What PI Lab is" — never silently clobber). A missing file
   * is a normal answer (`exists: false`), matching `read`.
   */
  stat: publicProcedure.input(readInput).query(async ({ ctx, input }): Promise<FileStat> => {
    const workspace = requireWorkspace(ctx.db, input.workspaceId)
    const dir = workspaceWorkingDir(ctx.db, workspace)
    const target = resolveInsideDir(dir, input.relPath)
    return statFile(target)
  }),

  /**
   * List one directory's immediate children for a lazy file tree. The root is
   * addressed by an empty `relPath`; child directories are expanded on demand by
   * passing their own `relPath`. Entries are returned directories-first then by
   * name (the order `listDir` already guarantees) with workspace-relative,
   * POSIX-separated paths so the renderer never sees absolute disk paths.
   */
  tree: publicProcedure.input(treeInput).query(async ({ ctx, input }): Promise<FileTreeEntry[]> => {
    const workspace = requireWorkspace(ctx.db, input.workspaceId)
    const dir = workspaceWorkingDir(ctx.db, workspace)
    // An empty relPath means the root itself; resolveInsideDir rejects "", so
    // resolve the base directly in that case.
    const base = resolve(dir)
    const target = input.relPath === "" ? base : resolveInsideDir(dir, input.relPath)
    const entries = await listDir(target)
    return entries
      .filter((entry) => !IGNORED_TREE_NAMES.has(entry.name))
      .map((entry) => ({
        name: entry.name,
        relPath: toRelPosix(base, entry.path),
        kind: entry.kind,
      }))
  }),

  /**
   * Fuzzy file-name search backing the `⌘F` quick-open palette. Scores every
   * file under the working dir against `query` (noise dirs like `.git` /
   * `node_modules` are pruned by `walkFiles`) and returns the best matches with
   * workspace-relative POSIX paths. An empty query yields no hits.
   */
  search: publicProcedure
    .input(searchInput)
    .query(async ({ ctx, input }): Promise<FileSearchHit[]> => {
      const workspace = requireWorkspace(ctx.db, input.workspaceId)
      const dir = workspaceWorkingDir(ctx.db, workspace)
      const base = resolve(dir)
      const hits = await searchFiles(base, input.query, { limit: input.limit })
      return hits.map((hit) => ({ relPath: toRelPosix(base, hit.path), score: hit.score }))
    }),
})

/**
 * Directory/file names hidden from the file tree. `.git` is excluded because it
 * is never something the user edits; the rest mirror {@link DEFAULT_IGNORED_DIRS}
 * intent for the *listing* path (search already prunes them via `walkFiles`).
 */
const IGNORED_TREE_NAMES = new Set([".git", "node_modules", ".turbo", "dist", ".cache"])

/** Convert an absolute path under `base` to a POSIX, working-dir-relative path. */
function toRelPosix(base: string, absPath: string): string {
  return relative(base, absPath).replaceAll(sep, "/")
}

/** Whether an error is Node's "no such file or directory". */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  )
}
