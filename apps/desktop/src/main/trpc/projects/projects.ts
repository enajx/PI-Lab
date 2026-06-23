import { resolve } from "node:path"
import { type Project, projects } from "@skipper/local-db"
import { TRPCError } from "@trpc/server"
import { desc, eq } from "drizzle-orm"
import { z } from "zod"
import { isGitRepo, repoName, repoRoot, resolveDefaultBranch } from "../../git"
import { publicProcedure, router } from "../trpc"

/**
 * Projects router — a Skipper "project" is a local git repository opened as a
 * research unit (AGENTS.md §0/§16). The router is thin: each procedure validates
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

export const projectsRouter = router({
  /**
   * Open a directory as a project: verify it's a git repo, resolve its root,
   * display name, and default branch, then upsert by `repoPath` (re-opening an
   * existing project refreshes its metadata and `lastOpenedAt` rather than
   * duplicating it). Returns the stored row.
   */
  open: publicProcedure.input(openInput).mutation(async ({ ctx, input }): Promise<Project> => {
    const dir = resolve(input.path)
    if (!(await isGitRepo(dir))) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Not a git repository: ${dir}`,
      })
    }

    // Normalize to the repo's top level so two sub-paths of one repo map to a
    // single project row (repoPath is unique).
    const root = await repoRoot(dir)
    const name = await repoName(root)
    const defaultBranch = await resolveDefaultBranch(root)
    const now = Date.now()

    const existing = ctx.db.select().from(projects).where(eq(projects.repoPath, root)).get()
    if (existing) {
      return ctx.db
        .update(projects)
        .set({ name, defaultBranch, updatedAt: now, lastOpenedAt: now })
        .where(eq(projects.id, existing.id))
        .returning()
        .get()
    }

    return ctx.db.insert(projects).values({ repoPath: root, name, defaultBranch }).returning().get()
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
