import type { Stats } from "node:fs"
import { constants, copyFile, lstat, mkdir, realpath, rename, writeFile } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { type PiLabDatabase, type Workspace, workspaces } from "@pi-lab/local-db"
import {
  type FileStat,
  listDir,
  readTextSnapshot,
  searchFiles,
  statFile,
  type TextSnapshot,
  verifyWrittenText,
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
 * `TODO.md`) and that the built-in editor reuses for save.
 *
 * Beyond read/write it exposes three editor primitives:
 *   - `stat` — a cheap fingerprint (mtime+size) the editor polls to notice
 *     out-of-band edits by agents/git and reload (clean) or warn (dirty).
 *   - `tree` — the immediate children of one directory, for a lazy file tree.
 *   - `search` — a fuzzy file-name search backing the `⌘F` quick-open palette.
 *
 * The file tree's manage actions add `trash` (OS Trash via the injected
 * `trashPath`), `rename`, `duplicate`, and `copyPath` (OS clipboard via the
 * injected `writeClipboard`), each jailed to the working dir.
 *
 * The router stays thin: it resolves the workspace's working dir, jails every
 * requested path to that dir, and delegates the real work to
 * `@pi-lab/workspace-fs`. Everything is `createCaller`-testable.
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

const renameInput = readInput.extend({
  /** New path for the entry, relative to the working dir. */
  newRelPath: z.string().min(1),
})

const copyPathInput = readInput.extend({
  /** `absolute` copies the full disk path; `relative` the working-dir-relative path. */
  form: z.enum(["absolute", "relative"]),
})

const searchInput = z.object({
  workspaceId: z.string().min(1),
  /** Fuzzy query against each file's path relative to the working dir. */
  query: z.string(),
  /** Cap on returned hits (the palette only shows a handful). */
  limit: z.number().int().positive().max(200).default(50),
})

/** Typed bounded editor read, with no content on rejected outcomes. */
export type FileReadResult = TextSnapshot

/** One entry in a directory listing, addressed relative to the working dir. */
export interface FileTreeEntry {
  /** The entry's own name (no path components). */
  name: string
  /** Path relative to the workspace working dir, POSIX-separated. */
  relPath: string
  kind: "file" | "dir"
  /** Normalized extension/type (`folder`, extension sans dot, or `file`). */
  type: string
  /** Last-modified time as epoch milliseconds. */
  mtimeMs: number
}

/** A ranked quick-open hit, addressed relative to the working dir. */
export interface FileSearchHit {
  /** Path relative to the workspace working dir, POSIX-separated. */
  relPath: string
  /** Fuzzy score (higher is better). */
  score: number
}

/** Search hits and child paths that could not be inspected. */
export interface FileSearchResult {
  hits: FileSearchHit[]
  partial: boolean
  skipped: string[]
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
 * stays *inside* `dir`. Absolute
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
    return readTextSnapshot(target)
  }),

  /**
   * Write a text file inside the workspace's working dir, creating parent
   * directories as needed (the built-in editor's save path). Returns the byte
   * length written so callers can confirm the round-trip.
   */
  write: publicProcedure
    .input(writeInput)
    .mutation(
      async ({
        ctx,
        input,
      }): Promise<{ bytes: number; baseline: FileStat; matchesWrittenContent: boolean }> => {
        const workspace = requireWorkspace(ctx.db, input.workspaceId)
        const dir = workspaceWorkingDir(ctx.db, workspace)
        const target = resolveInsideDir(dir, input.relPath)
        await writeTextFile(target, input.content)
        const verified = await verifyWrittenText(target, input.content)
        return {
          bytes: Buffer.byteLength(input.content, "utf8"),
          ...verified,
        }
      },
    ),

  /** Reveal only existing files whose real path stays inside this workspace. */
  reveal: publicProcedure.input(readInput).mutation(async ({ ctx, input }): Promise<void> => {
    const workspace = requireWorkspace(ctx.db, input.workspaceId)
    const base = await realpath(workspaceWorkingDir(ctx.db, workspace))
    const target = await realpath(resolveInsideDir(base, input.relPath))
    const rel = relative(base, target)
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Cannot reveal a path outside the workspace",
      })
    await ctx.revealPath(target)
  }),

  /**
   * Fingerprint a file (mtime + size) without reading its bytes. The editor
   * polls this to detect agent/git edits on disk: a clean buffer auto-reloads,
   * a dirty buffer warns. A missing file
   * is a normal answer (`exists: false`), matching `read`.
   */
  stat: publicProcedure.input(readInput).query(async ({ ctx, input }): Promise<FileStat> => {
    const workspace = requireWorkspace(ctx.db, input.workspaceId)
    const dir = workspaceWorkingDir(ctx.db, workspace)
    const target = resolveInsideDir(dir, input.relPath)
    return statFile(target)
  }),

  /** Create one new, empty file without overwriting an existing filesystem entry. */
  createFile: publicProcedure
    .input(readInput)
    .mutation(async ({ ctx, input }): Promise<{ relPath: string }> => {
      return createEntry(ctx.db, input.workspaceId, input.relPath, "file")
    }),

  /** Create one new, empty folder without recursively inventing missing parents. */
  createFolder: publicProcedure
    .input(readInput)
    .mutation(async ({ ctx, input }): Promise<{ relPath: string }> => {
      return createEntry(ctx.db, input.workspaceId, input.relPath, "dir")
    }),

  /**
   * Move one existing file or folder inside the workspace to the OS Trash. The
   * entry itself must exist and its real parent must stay inside the real
   * workspace, so a symlinked parent cannot redirect the delete outside it. A
   * symlink entry is trashed as the link, never its target.
   */
  trash: publicProcedure.input(readInput).mutation(async ({ ctx, input }): Promise<void> => {
    const workspace = requireWorkspace(ctx.db, input.workspaceId)
    const base = resolve(workspaceWorkingDir(ctx.db, workspace))
    const target = resolveInsideDir(base, input.relPath)
    await requireRealParentInside(base, target, input.relPath)
    await requireEntry(target, input.relPath)
    await ctx.trashPath(target)
  }),

  /**
   * Rename or move one existing entry to a new path inside the workspace without
   * overwriting another entry. A case-only rename of the same entry is allowed.
   */
  rename: publicProcedure
    .input(renameInput)
    .mutation(async ({ ctx, input }): Promise<{ relPath: string }> => {
      const workspace = requireWorkspace(ctx.db, input.workspaceId)
      const base = resolve(workspaceWorkingDir(ctx.db, workspace))
      const source = resolveInsideDir(base, input.relPath)
      const destination = resolveInsideDir(base, input.newRelPath)
      await requireRealParentInside(base, source, input.relPath)
      await requireRealParentInside(base, destination, input.newRelPath)
      const sourceInfo = await requireEntry(source, input.relPath)
      const existing = await lstat(destination).catch((error: unknown) => {
        if (nodeErrorCode(error) === "ENOENT") return null
        throw error
      })
      // On a case-insensitive disk `A.txt` → `a.txt` finds the source itself.
      if (existing && !(existing.ino === sourceInfo.ino && existing.dev === sourceInfo.dev)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `A file or folder already exists at ${input.newRelPath}`,
        })
      }
      await rename(source, destination)
      return { relPath: toRelPosix(base, destination) }
    }),

  /**
   * Copy one file next to itself under a Finder-style name (`name copy.ext`,
   * then `name copy 2.ext`, ...), never overwriting an existing entry.
   */
  duplicate: publicProcedure
    .input(readInput)
    .mutation(async ({ ctx, input }): Promise<{ relPath: string }> => {
      const workspace = requireWorkspace(ctx.db, input.workspaceId)
      const base = resolve(workspaceWorkingDir(ctx.db, workspace))
      const source = resolveInsideDir(base, input.relPath)
      await requireRealParentInside(base, source, input.relPath)
      const info = await requireEntry(source, input.relPath)
      if (!info.isFile()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Only files can be duplicated: ${input.relPath}`,
        })
      }
      for (let attempt = 1; ; attempt += 1) {
        const destination = join(dirname(source), copyName(basename(source), attempt))
        try {
          await copyFile(source, destination, constants.COPYFILE_EXCL)
          return { relPath: toRelPosix(base, destination) }
        } catch (error) {
          if (nodeErrorCode(error) !== "EEXIST") throw error
        }
      }
    }),

  /** Write an entry's absolute or working-dir-relative path to the OS clipboard. */
  copyPath: publicProcedure.input(copyPathInput).mutation(async ({ ctx, input }): Promise<void> => {
    const workspace = requireWorkspace(ctx.db, input.workspaceId)
    const base = resolve(workspaceWorkingDir(ctx.db, workspace))
    const target = resolveInsideDir(base, input.relPath)
    ctx.writeClipboard(input.form === "absolute" ? target : toRelPosix(base, target))
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
        type: entry.kind === "dir" ? "folder" : fileType(entry.name),
        mtimeMs: entry.mtimeMs,
      }))
  }),

  /**
   * Fuzzy file-name search backing the `⌘F` quick-open palette. Scores every
   * file under the working dir against `query` (noise dirs like `.git` /
   * `node_modules` are pruned by the shared walker) and returns the best matches with
   * workspace-relative POSIX paths. An empty query yields no hits.
   */
  search: publicProcedure
    .input(searchInput)
    .query(async ({ ctx, input }): Promise<FileSearchResult> => {
      const workspace = requireWorkspace(ctx.db, input.workspaceId)
      const dir = workspaceWorkingDir(ctx.db, workspace)
      const base = resolve(dir)
      const result = await searchFiles(base, input.query, { limit: input.limit })
      return {
        hits: result.hits.map((hit) => ({ relPath: toRelPosix(base, hit.path), score: hit.score })),
        partial: result.partial,
        skipped: result.skipped,
      }
    }),
})

/**
 * Create a single entry after checking both the lexical path jail and the real
 * parent directory. The realpath check prevents a workspace symlink from
 * redirecting creation outside the working directory.
 */
async function createEntry(
  db: PiLabDatabase,
  workspaceId: string,
  relPath: string,
  kind: "file" | "dir",
): Promise<{ relPath: string }> {
  const workspace = requireWorkspace(db, workspaceId)
  const dir = workspaceWorkingDir(db, workspace)
  const base = resolve(dir)
  const target = resolveInsideDir(base, relPath)
  await requireRealParentInside(base, target, relPath)

  try {
    if (kind === "file") {
      await writeFile(target, "", { encoding: "utf8", flag: "wx" })
    } else {
      await mkdir(target)
    }
  } catch (error) {
    const code = nodeErrorCode(error)
    if (code === "EEXIST") {
      throw new TRPCError({
        code: "CONFLICT",
        message: `A file or folder already exists at ${relPath}`,
        cause: error,
      })
    }
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EINVAL") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Cannot create ${relPath}: its parent folder is missing or the name is invalid`,
        cause: error,
      })
    }
    throw error
  }

  return { relPath: toRelPosix(base, target) }
}

/** `lstat` an entry (not following a final symlink), mapping absence to NOT_FOUND. */
async function requireEntry(target: string, relPath: string): Promise<Stats> {
  try {
    return await lstat(target)
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `No file or folder at ${relPath}`,
        cause: error,
      })
    }
    throw error
  }
}

/**
 * Finder-style duplicate name: `notes.md` → `notes copy.md`, `notes copy 2.md`.
 * A leading dot is part of the name, so `.env` → `.env copy`.
 */
function copyName(name: string, attempt: number): string {
  const extension = extname(name)
  const stem = extension ? name.slice(0, -extension.length) : name
  const suffix = attempt === 1 ? " copy" : ` copy ${attempt}`
  return `${stem}${suffix}${extension}`
}

/** Confirm the target's existing real parent remains inside the real workspace. */
async function requireRealParentInside(
  base: string,
  target: string,
  relPath: string,
): Promise<void> {
  const realBase = await realpath(base)
  let realParent: string
  try {
    realParent = await realpath(dirname(target))
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Cannot create ${relPath}: its parent folder does not exist`,
        cause: error,
      })
    }
    throw error
  }
  const rel = relative(realBase, realParent)
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Path escapes the workspace directory through its parent: ${relPath}`,
    })
  }
}

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

/** Lowercase extension sans dot, or `file` for extensionless/dotfiles. */
function fileType(name: string): string {
  return extname(name).slice(1).toLowerCase() || "file"
}

/** Extract a Node filesystem error code without hiding unknown errors. */
function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}
