import type { Stats } from "node:fs"
import { cp, mkdir, readdir, stat } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { type Project, projects, type SkipperDatabase } from "@skipper/local-db"
import { TRPCError } from "@trpc/server"
import { desc, eq } from "drizzle-orm"
import { z } from "zod"
import { GitError, isGitRepo, repoName, repoRoot, resolveDefaultBranch, runGit } from "../../git"
import { resolveWritableTemplateDir, seedWritableTemplate } from "../template"
import { publicProcedure, router } from "../trpc"

/**
 * Projects router — a Skipper "project" is a local git repository opened as a
 * research unit (AGENTS.md "What Skipper is", "Glossary"). The router is thin: each procedure validates
 * input, calls the git layer and the injected Drizzle handle, and returns rows.
 * No orchestration, no cloud — just the local store.
 */

const openInput = z.object({
  /** Absolute path to a directory inside a git working tree. */
  path: z.string().min(1),
})

const idInput = z.object({ id: z.string().min(1) })

const setThumbnailInput = z.object({
  id: z.string().min(1),
  /**
   * A `data:` image URL to use as the card's header image, or `null` to clear it
   * (reverting the card to its seeded gradient). Only `data:` URLs are accepted —
   * the renderer reads the dropped file into one, so the row stays self-contained
   * (no external paths to dangle).
   */
  dataUrl: z.string().startsWith("data:").nullable(),
})

const cloneInput = z.object({
  /** A git remote — http(s)/ssh/scp-style URL or a local path; git is the arbiter. */
  url: z.string().min(1),
  /** Absolute directory the clone will land *inside* (the repo gets its own subdir). */
  parentDir: z.string().min(1),
})

const createFromTemplateInput = z.object({
  /** Absolute directory to create as the new project; the template copies into it. */
  targetDir: z.string().min(1),
  /**
   * Template folder to copy from. Defaults to the writable bundled template under
   * the data dir ({@link resolveWritableTemplateDir}); explicit callers/tests may
   * name any source directory.
   */
  templateDir: z.string().optional(),
})

/**
 * Verify `dir` is a git working tree, then upsert its project row keyed on the
 * repo's top-level path (re-opening refreshes metadata + `lastOpenedAt` rather
 * than duplicating). Shared by `open`, `clone`, and `createFromTemplate` so the
 * three entry points agree on a single verify-and-store path. Throws a clean
 * `BAD_REQUEST` when `dir` is not a repo.
 */
async function upsertProjectFromRepo(db: SkipperDatabase, dir: string): Promise<Project> {
  if (!(await isGitRepo(dir))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Not a git repository: ${dir}` })
  }

  // Normalize to the repo's top level so two sub-paths of one repo map to a
  // single project row (repoPath is unique).
  const root = await repoRoot(dir)
  const name = await repoName(root)
  const defaultBranch = await resolveDefaultBranch(root)
  const now = Date.now()

  const existing = db.select().from(projects).where(eq(projects.repoPath, root)).get()
  if (existing) {
    return db
      .update(projects)
      .set({ name, defaultBranch, updatedAt: now, lastOpenedAt: now })
      .where(eq(projects.id, existing.id))
      .returning()
      .get()
  }

  return db.insert(projects).values({ repoPath: root, name, defaultBranch }).returning().get()
}

/**
 * The folder name to create for a cloned remote: the URL's last path segment with
 * any trailing `.git` and slashes stripped (e.g. `git@host:org/repo.git` ⇒ `repo`,
 * `https://host/org/repo/` ⇒ `repo`). Falls back to `"repo"` if nothing is left,
 * so a degenerate URL still yields a usable dir (git then rejects a bad remote).
 */
function repoDirNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "")
  const lastSegment = trimmed.split(/[/:]/).pop() ?? ""
  const name = lastSegment.replace(/\.git$/i, "").trim()
  return name || "repo"
}

/** Whether `dir` already exists on disk (any node — file or directory). */
async function pathExists(dir: string): Promise<boolean> {
  try {
    await stat(dir)
    return true
  } catch {
    return false
  }
}

/** `stat` for `dir`, or `null` when it doesn't exist — to branch on type/emptiness. */
async function statOrNull(dir: string): Promise<Stats | null> {
  try {
    return await stat(dir)
  } catch {
    return null
  }
}

export const projectsRouter = router({
  /**
   * Open a directory as a project: verify it's a git repo, resolve its root,
   * display name, and default branch, then upsert by `repoPath` (re-opening an
   * existing project refreshes its metadata and `lastOpenedAt` rather than
   * duplicating it). Returns the stored row.
   */
  open: publicProcedure.input(openInput).mutation(({ ctx, input }): Promise<Project> => {
    return upsertProjectFromRepo(ctx.db, resolve(input.path))
  }),

  /**
   * Clone a remote into `parentDir` and open the result as a project. The target
   * folder is derived from the URL (last path segment, sans `.git`); if it already
   * exists we refuse rather than clobber. Git is the arbiter of a valid remote —
   * a bad URL surfaces as a clean `BAD_REQUEST` carrying git's own stderr (kept
   * selectable in the UI). On success the clone is verified and upserted.
   */
  clone: publicProcedure.input(cloneInput).mutation(async ({ ctx, input }): Promise<Project> => {
    const parentDir = resolve(input.parentDir)
    const target = join(parentDir, repoDirNameFromUrl(input.url))

    if (await pathExists(target)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `A directory already exists at ${target} — choose another location or remove it first.`,
      })
    }

    // `git clone` creates the leaf dir but not intermediate parents; ensure the
    // destination's parent exists so a fresh location works on the first try.
    await mkdir(parentDir, { recursive: true })

    try {
      // `--` stops the URL/path being parsed as an option. cwd is the parent so
      // the destination is created relative to a directory that already exists.
      await runGit(parentDir, ["clone", "--", input.url, target])
    } catch (error) {
      if (error instanceof GitError) {
        throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error })
      }
      throw error
    }

    return upsertProjectFromRepo(ctx.db, target)
  }),

  /**
   * Create a fresh project by copying a template folder into `targetDir`. The
   * template defaults to the writable bundled template ({@link
   * resolveWritableTemplateDir}, first-run-seeded here as a safety net) but the
   * caller may name any source directory. We refuse to clobber a non-empty target,
   * copy the template's contents in (symlinks preserved, `.DS_Store` and any nested
   * `.git` skipped), `git init` + initial-commit the result unless it already lives
   * in a repo, then verify + upsert through the shared path.
   */
  createFromTemplate: publicProcedure
    .input(createFromTemplateInput)
    .mutation(async ({ ctx, input }): Promise<Project> => {
      let templateDir: string
      if (input.templateDir) {
        templateDir = resolve(input.templateDir)
      } else {
        // Default source: ensure the writable template is seeded, then copy from it.
        await seedWritableTemplate()
        templateDir = resolveWritableTemplateDir()
      }
      const target = resolve(input.targetDir)

      // The template must be an existing directory to copy from.
      const template = await statOrNull(templateDir)
      if (!template?.isDirectory()) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Template not found: ${templateDir}` })
      }

      // Never clobber a non-empty target; an absent or empty directory is fine.
      const existing = await statOrNull(target)
      if (existing) {
        if (!existing.isDirectory() || (await readdir(target)).length > 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `A non-empty directory already exists at ${target} — choose another location or empty it first.`,
          })
        }
      } else {
        await mkdir(target, { recursive: true })
      }

      // Copy the template's contents in, preserving symlinks (e.g. CLAUDE.md ->
      // AGENTS.md) and skipping editor/VCS cruft so the new repo starts clean.
      try {
        await cp(templateDir, target, {
          recursive: true,
          verbatimSymlinks: true,
          filter: (src) => {
            const base = basename(src)
            return base !== ".DS_Store" && base !== ".git"
          },
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to copy template into ${target}: ${detail}`,
          cause: error,
        })
      }

      // A copied template carries no `.git` (we skip it), so init + commit unless
      // the target already sits inside a repo — open() needs a real working tree.
      if (!(await isGitRepo(target))) {
        try {
          await runGit(target, ["init", "-b", "main"])
          await runGit(target, ["add", "-A"])
          await runGit(target, ["commit", "-m", "Initial commit"])
        } catch (error) {
          if (error instanceof GitError) {
            throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error })
          }
          throw error
        }
      }

      return upsertProjectFromRepo(ctx.db, target)
    }),

  /** Active (non-archived) projects, most-recently-opened first. */
  list: publicProcedure.query(({ ctx }): Project[] => {
    return ctx.db.select().from(projects).orderBy(desc(projects.lastOpenedAt)).all()
  }),

  /** A single project by id, or throws NOT_FOUND. */
  get: publicProcedure.input(idInput).query(({ ctx, input }): Project => {
    const row = ctx.db.select().from(projects).where(eq(projects.id, input.id)).get()
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
    }
    return row
  }),

  /**
   * Delete a project row (cascades to its worktrees/workspaces via the schema's
   * `onDelete: "cascade"`). The on-disk repo is the user's own and is never
   * touched — Skipper only forgets it.
   */
  remove: publicProcedure.input(idInput).mutation(({ ctx, input }) => {
    ctx.db.delete(projects).where(eq(projects.id, input.id)).run()
    return { ok: true as const }
  }),

  /**
   * Set (or clear, with `dataUrl: null`) the project's dashboard card thumbnail.
   * The renderer drops an image file onto a card and reads it into a `data:` URL,
   * which we persist verbatim; clearing reverts the card to its seeded gradient.
   * Returns the updated row so the dashboard re-renders from the mutation result.
   */
  setThumbnail: publicProcedure.input(setThumbnailInput).mutation(({ ctx, input }): Project => {
    const row = ctx.db
      .update(projects)
      .set({ thumbnail: input.dataUrl, updatedAt: Date.now() })
      .where(eq(projects.id, input.id))
      .returning()
      .get()
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
    }
    return row
  }),

  /** Bump `lastOpenedAt` so the project rises in "recent" ordering. */
  touch: publicProcedure.input(idInput).mutation(({ ctx, input }): Project => {
    const row = ctx.db
      .update(projects)
      .set({ lastOpenedAt: Date.now() })
      .where(eq(projects.id, input.id))
      .returning()
      .get()
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
    }
    return row
  }),
})
