import { mkdir, realpath, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, sep } from "node:path"
import { type PiLabDatabase, projects, workspaces } from "@pi-lab/local-db"
import { classifyDataFile } from "@pi-lab/shared"
import { TRPCError } from "@trpc/server"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { resolveWorkspacePythonRuntime } from "../../../python"
import { resolveInsideDir } from "../../files/files"
import { publicProcedure, router } from "../../trpc"
import {
  type DataFileListing,
  type DataFilePreview,
  discoverDataFiles,
  isMarimoNotebookFile,
  previewDataFile,
} from "./discover"
import type { AnalysisInteractiveResult } from "./interactive"

/**
 * Analysis science tab — v1 is a **read-only
 * data browser**: discover and classify the data/analysis files in a project's
 * repo, list them grouped by kind, and render a bounded preview of a selected
 * file (a sampled CSV/TSV table, a pretty-printed JSON, an inline image, or a
 * text head; everything else falls back to a metadata card). Interactive
 * charting / plotting is deliberately deferred to later.
 *
 * Both procedures resolve the project's repo path from the injected Drizzle
 * handle, then delegate to the plain, filesystem-only functions in `./discover`.
 * `preview` jails its `relPath` to the repo via the shared {@link resolveInsideDir}
 * guard. Mounted as `science.analysis.*`.
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

const interactiveInput = previewInput.extend({
  ownerId: z.string().min(1),
  leaseId: z.string().min(1),
})

const closeInteractiveInput = z.object({
  ownerId: z.string().min(1),
  leaseId: z.string().min(1),
})

const createTemplateInput = z.object({
  projectId: z.string().min(1),
  kind: z.enum(["html", "marimo"]),
})

const HTML_REPORT_TEMPLATE = `<!doctype html>
<html lang="en">
  <meta charset="utf-8" />
  <title>PI Lab report</title>
  <body>
    <h1>Interactive report</h1>
    <p>Edit this file, then refresh the preview.</p>
    <button id="counter">0</button>
    <script>
      const counter = document.querySelector("#counter")
      counter.addEventListener("click", () => {
        counter.textContent = String(Number(counter.textContent) + 1)
      })
    </script>
  </body>
</html>
`

const MARIMO_NOTEBOOK_TEMPLATE = `import marimo

app = marimo.App()


@app.cell
def _():
    import marimo as mo
    return mo,


@app.cell
def _(mo):
    mo.md("# Interactive notebook\\n\\nEdit this marimo notebook and save it to update the preview.")
    return


if __name__ == "__main__":
    app.run()
`

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
   * Create a ready-to-run interactive artifact under `reports/`. Existing
   * files are never overwritten: a numeric suffix is selected atomically and
   * returned so the UI can state exactly what it created.
   */
  createTemplate: publicProcedure
    .input(createTemplateInput)
    .mutation(async ({ ctx, input }): Promise<{ relPath: string }> => {
      const repoPath = requireRepoPath(ctx.db, input.projectId)
      const baseName = input.kind === "html" ? "report" : "notebook"
      const extension = input.kind === "html" ? ".html" : ".py"
      const content = input.kind === "html" ? HTML_REPORT_TEMPLATE : MARIMO_NOTEBOOK_TEMPLATE
      for (let suffix = 0; suffix < 10_000; suffix += 1) {
        const name = `${baseName}${suffix === 0 ? "" : `-${suffix}`}${extension}`
        const relPath = `reports/${name}`
        const target = resolveInsideDir(repoPath, relPath)
        await mkdir(dirname(target), { recursive: true })
        try {
          await writeFile(target, content, { encoding: "utf8", flag: "wx" })
          return { relPath }
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue
          throw error
        }
      }
      throw new TRPCError({
        code: "CONFLICT",
        message: "Could not find an available report filename",
      })
    }),
  /**
   * Discover and classify the data/analysis files in a project's repo. Walks the
   * tree (skipping noise dirs), tags each file with its data-file kind, and
   * returns them grouped by kind with per-file metadata (size, mtime). The walk
   * is capped, and `truncated` flags when the cap was hit so the UI can say so
   * rather than silently dropping files.
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

  /**
   * Open an interactive report or marimo notebook. The renderer receives only
   * an isolated URL; report file grants and live Python children remain owned by
   * the app-lifetime controller in Electron main.
   */
  openInteractive: publicProcedure
    .input(interactiveInput)
    .mutation(async ({ ctx, input }): Promise<AnalysisInteractiveResult> => {
      const repoPath = requireRepoPath(ctx.db, input.projectId)
      const generation = await ctx.analysisInteractive.begin(input.ownerId, input.leaseId)
      const absPath = resolveInsideDir(repoPath, input.relPath)
      if (classifyDataFile(input.relPath) === "report") {
        return ctx.analysisInteractive.openReport({
          ownerId: input.ownerId,
          generation,
          repoPath,
          absPath,
        })
      }
      if (!(await isMarimoNotebookFile(absPath))) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${input.relPath} is not a marimo notebook`,
        })
      }

      const [canonicalRepo, canonicalNotebook] = await Promise.all([
        realpath(repoPath),
        realpath(absPath),
      ])
      const canonicalRelPath = relative(canonicalRepo, canonicalNotebook)
      if (
        canonicalRelPath === "" ||
        canonicalRelPath === ".." ||
        canonicalRelPath.startsWith(`..${sep}`) ||
        isAbsolute(canonicalRelPath)
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Path escapes the project directory: ${input.relPath}`,
        })
      }
      if (!(await stat(canonicalNotebook)).isFile()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "marimo requires a Python file" })
      }

      const workspace = ctx.db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.projectId, input.projectId), eq(workspaces.kind, "branch")))
        .get()
      const runtime = await resolveWorkspacePythonRuntime(
        ctx.resolvePythonRuntime,
        canonicalRepo,
        workspace?.pythonEnvironmentPath ?? null,
      )
      const portBase = workspace?.portBase ?? 41_000
      return ctx.analysisInteractive.startMarimo({
        ownerId: input.ownerId,
        generation,
        cwd: canonicalRepo,
        absPath: canonicalNotebook,
        runtime,
        portRange: { start: portBase, end: portBase + 9 },
      })
    }),

  /** Revoke a report URL and/or stop the owner's live marimo process. Idempotent. */
  closeInteractive: publicProcedure
    .input(closeInteractiveInput)
    .mutation(async ({ ctx, input }): Promise<void> => {
      await ctx.analysisInteractive.close(input.ownerId, input.leaseId)
    }),
})
