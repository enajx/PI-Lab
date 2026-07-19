import { type PiLabDatabase, projects } from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { resolveInsideDir } from "../../files/files"
import { publicProcedure, router } from "../../trpc"
import {
  type DataFileListing,
  type DataFilePreview,
  discoverDataFiles,
  previewDataFile,
} from "./discover"

/**
 * Analysis science tab (AGENTS.md "Scope" "Science tabs", P8c) — v1 is a **read-only
 * data browser**: discover and classify the data/analysis files in a project's
 * repo, list them grouped by kind, and render a bounded preview of a selected
 * file (a sampled CSV/TSV table, a pretty-printed JSON, an inline image, or a
 * text head; everything else falls back to a metadata card). Interactive
 * charting / plotting is deliberately deferred to later.
 *
 * Both procedures resolve the project's repo path from the injected Drizzle
 * handle, then delegate to the plain, filesystem-only functions in `./discover`.
 * `preview` jails its `relPath` to the repo via the shared {@link resolveInsideDir}
 * guard (md/engineering/architecture.md (process model) — path-traversal). Mounted as `science.analysis.*`.
 */

const listInput = z.object({
  /** The project whose repo is scanned for data files. */
  projectId: z.string().min(1),
})

const previewInput = z.object({
  projectId: z.string().min(1),
  /** Repo-relative path of the file to preview (POSIX or native separators). */
  relPath: z.string().min(1),
})

/** Resolve a project's repo path from the store or throw a clean NOT_FOUND. */
function requireRepoPath(db: PiLabDatabase, projectId: string): string {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: `No project ${projectId}` })
  }
  return project.repoPath
}

export const analysisRouter = router({
  /**
   * Discover and classify the data/analysis files in a project's repo. Walks the
   * tree (skipping noise dirs), tags each file with its data-file kind, and
   * returns them grouped by kind with per-file metadata (size, mtime). The walk
   * is capped, and `truncated` flags when the cap was hit so the UI can say so
   * rather than silently dropping files (AGENTS.md — no silent caps).
   */
  listFiles: publicProcedure
    .input(listInput)
    .query(async ({ ctx, input }): Promise<DataFileListing> => {
      const repoPath = requireRepoPath(ctx.db, input.projectId)
      return discoverDataFiles(repoPath)
    }),

  /**
   * Return a bounded preview of one repo file, dispatched by its kind. The
   * `relPath` is jailed to the repo (path-traversal guard); a missing file is a
   * clean NOT_FOUND. The preview payload is always size-bounded so a huge file
   * can never balloon the IPC response.
   */
  preview: publicProcedure
    .input(previewInput)
    .query(async ({ ctx, input }): Promise<DataFilePreview> => {
      const repoPath = requireRepoPath(ctx.db, input.projectId)
      const abs = resolveInsideDir(repoPath, input.relPath)
      return previewDataFile(abs, input.relPath)
    }),
})
