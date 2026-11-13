import { mkdir, realpath, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, sep } from "node:path"
import {
  type PiLabDatabase,
  type Project,
  type ProjectMetadata,
  projects,
  workspaces,
} from "@pi-lab/local-db"
import { classifyDataFile } from "@pi-lab/shared"
import { type FileStat, statFile } from "@pi-lab/workspace-fs"
import { TRPCError } from "@trpc/server"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { resolveWorkspacePythonRuntime } from "../../../python"
import { resolveInsideDir } from "../../files/files"
import { insideFile, type PdfSnapshot, readPdfSnapshot } from "../../pdf/pdf"
import { publicProcedure, router } from "../../trpc"
import {
  type DataFileListing,
  type DataFilePreview,
  discoverDataFiles,
  isMarimoNotebookFile,
} from "./discover"
import type { AnalysisInteractiveResult } from "./interactive"
import { analysisMedia } from "./mediaGrants"
import {
  effectiveStructureValue,
  readStructureFile,
  requireStructure,
  structureFilePath,
  writeStructureFile,
} from "./structure"

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
  /** The project whose results folder is scanned for data files. */
  projectId: z.string().min(1),
  /**
   * The default results folder from Settings, relative to the project. Used
   * when the project has no results folder of its own.
   */
  defaultResultsFolder: z.string().min(1),
})

const setResultsFolderInput = z.object({
  projectId: z.string().min(1),
  /** Absolute folder path from the folder picker, or null to use the default again. */
  dir: z.string().min(1).nullable(),
})

/** The Analysis file listing of a project's results folder. */
export interface ResultsListing extends DataFileListing {
  /** The results folder that was listed, relative to the project (POSIX separators). */
  resultsFolder: string
  /** True when the project's own folder was used instead of the default. */
  overridden: boolean
  /** False when the results folder does not exist (the listing is then empty). */
  exists: boolean
}

const getStructureInput = z.object({
  /** The project whose own structure is read, or null for only the default. */
  projectId: z.string().min(1).nullable(),
})

const setStructureInput = z.object({
  /** The project whose own structure is set, or null to set the default. */
  projectId: z.string().min(1).nullable(),
  /** A preset id or a pattern; null removes the project's own entry (the default applies). */
  value: z.string().min(1).nullable(),
})

/** The experiments folder structure settings, from the YAML file in PI Lab's data folder. */
export interface StructureSettings {
  /** The YAML file's full path. */
  filePath: string
  /** The default structure value (a preset id or a pattern). */
  defaultValue: string
  /** The project's own value, or null when it uses the default (or no project was given). */
  projectValue: string | null
}

const previewInput = z.object({
  projectId: z.string().min(1),
  /** Repo-relative path of the file to preview (POSIX or native separators). */
  relPath: z.string().min(1),
})

const dataPreviewInput = previewInput.extend({
  /** Read the file even when it is above its format's size limit (the Load button). */
  load: z.boolean(),
  /** The HDF5 dataset to preview, or null for the first one. */
  dataset: z.string().min(1).nullable(),
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
  kind: z.enum(["marimo"]),
})

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

/** Resolve a project's row from the store or throw a clean NOT_FOUND. */
function requireProject(db: PiLabDatabase, projectId: string): Project {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: `No project ${projectId}` })
  }
  return project
}

/** Resolve a project's repo path from the store or throw a clean NOT_FOUND. */
function requireRepoPath(db: PiLabDatabase, projectId: string): string {
  return requireProject(db, projectId).repoPath
}

/** True when `child` is a folder strictly inside `parent` (both absolute). */
function isStrictlyInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Return the folder's path relative to the project (POSIX separators), from
 * both real paths (after symlinks). FORBIDDEN unless it is strictly inside.
 */
async function realPathInside(repoPath: string, dir: string, shown: string): Promise<string> {
  const [canonicalRepo, canonicalDir] = await Promise.all([realpath(repoPath), realpath(dir)])
  if (!isStrictlyInside(canonicalRepo, canonicalDir)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `The results folder must be inside the project: ${shown}`,
    })
  }
  return relative(canonicalRepo, canonicalDir).replaceAll("\\", "/")
}

/** The project's reports folder, which Analysis lists next to the results folder. */
const REPORTS_FOLDER = "reports"

const EMPTY_LISTING: DataFileListing = {
  groups: [],
  total: 0,
  truncatedExperiments: [],
  partial: false,
  skipped: [],
}

/**
 * List the project's `reports/` folder, or an empty listing when it does not
 * exist (or is not a folder). A `reports` symlink that leaves the project is
 * refused like a results folder.
 */
async function listReportsFolder(repoPath: string): Promise<DataFileListing> {
  const root = resolveInsideDir(repoPath, REPORTS_FOLDER)
  const info = await statOrNull(root)
  if (info === null || !info.isDirectory()) return EMPTY_LISTING
  await realPathInside(repoPath, root, REPORTS_FOLDER)
  return discoverDataFiles(repoPath, root, "reports", { kind: "flat" })
}

/**
 * Join the results listing and the reports listing, keeping kind groups in the
 * results listing's order. A file in both (the results folder is or is inside
 * `reports/`, or holds it) is kept once, from the results listing.
 */
function mergeListings(results: DataFileListing, reports: DataFileListing): DataFileListing {
  const seen = new Set(results.groups.flatMap((group) => group.files.map((file) => file.relPath)))
  const groups = results.groups.map((group) => ({ kind: group.kind, files: [...group.files] }))
  let added = 0
  for (const group of reports.groups) {
    const files = group.files.filter((file) => !seen.has(file.relPath))
    if (files.length === 0) continue
    added += files.length
    const existing = groups.find((candidate) => candidate.kind === group.kind)
    if (existing) existing.files.push(...files)
    else groups.push({ kind: group.kind, files })
  }
  const skipped = [...new Set([...results.skipped, ...reports.skipped])]
  return {
    groups,
    total: results.total + added,
    truncatedExperiments: [...results.truncatedExperiments, ...reports.truncatedExperiments],
    partial: skipped.length > 0,
    skipped,
  }
}

/** stat that answers null for a missing path; other errors surface. */
async function statOrNull(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export const analysisRouter = router({
  /**
   * Read the experiments folder structure settings: the default and, for a
   * project, its own entry (keyed by its path). An invalid file is BAD_REQUEST
   * naming the file, never a silent fallback.
   */
  getStructure: publicProcedure
    .input(getStructureInput)
    .query(async ({ ctx, input }): Promise<StructureSettings> => {
      const filePath = structureFilePath(ctx.userDataDir)
      const file = await readStructureFile(filePath)
      const projectValue =
        input.projectId === null
          ? null
          : (file.projects[requireRepoPath(ctx.db, input.projectId)] ?? null)
      return { filePath, defaultValue: file.defaultValue, projectValue }
    }),

  /**
   * Set the default structure (`projectId: null`) or a project's own one, and
   * write the YAML file. `value: null` removes the project's entry. An unknown
   * preset or invalid pattern is BAD_REQUEST, and an invalid file is never
   * overwritten (BAD_REQUEST naming the file).
   */
  setStructure: publicProcedure
    .input(setStructureInput)
    .mutation(async ({ ctx, input }): Promise<StructureSettings> => {
      const filePath = structureFilePath(ctx.userDataDir)
      const file = await readStructureFile(filePath)
      if (input.value !== null) requireStructure(input.value, "Experiments structure")
      if (input.projectId === null) {
        if (input.value === null) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "The default experiments structure cannot be removed",
          })
        }
        file.defaultValue = input.value
      } else {
        const projectPath = requireRepoPath(ctx.db, input.projectId)
        if (input.value === null) delete file.projects[projectPath]
        else file.projects[projectPath] = input.value
      }
      await mkdir(ctx.userDataDir, { recursive: true })
      await writeStructureFile(filePath, file)
      const projectValue =
        input.projectId === null
          ? null
          : (file.projects[requireRepoPath(ctx.db, input.projectId)] ?? null)
      return { filePath, defaultValue: file.defaultValue, projectValue }
    }),

  /**
   * Create a ready-to-run marimo notebook under `reports/`. Existing
   * files are never overwritten: a numeric suffix is selected atomically and
   * returned so the UI can state exactly what it created.
   */
  createTemplate: publicProcedure
    .input(createTemplateInput)
    .mutation(async ({ ctx, input }): Promise<{ relPath: string }> => {
      const repoPath = requireRepoPath(ctx.db, input.projectId)
      for (let suffix = 0; suffix < 10_000; suffix += 1) {
        const name = `notebook${suffix === 0 ? "" : `-${suffix}`}.py`
        const relPath = `reports/${name}`
        const target = resolveInsideDir(repoPath, relPath)
        await mkdir(dirname(target), { recursive: true })
        try {
          await writeFile(target, MARIMO_NOTEBOOK_TEMPLATE, { encoding: "utf8", flag: "wx" })
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
   * Discover and classify the data/analysis files in a project's results folder
   * (the project's own folder, else the default from Settings). Every file
   * carries its group, experiment and path inside them from the project's
   * experiments folder structure (see `getStructure`); an invalid structure file is
   * BAD_REQUEST. Walks the tree (skipping
   * noise dirs), tags each file with its data-file kind, and returns them
   * grouped by kind with per-file metadata (size, mtime) and repo-relative
   * paths. The project's `reports/` folder is
   * listed too, marked `inReportsFolder`, each file once; no `reports/` folder
   * adds nothing. A missing results folder is `exists: false`; a folder outside the
   * project (or the project folder itself) is FORBIDDEN. Each experiment is
   * capped, and `truncatedExperiments` names the ones that were cut.
   */
  listFiles: publicProcedure
    .input(listInput)
    .query(async ({ ctx, input }): Promise<ResultsListing> => {
      const project = requireProject(ctx.db, input.projectId)
      const own = project.metadata?.resultsFolder
      const resultsFolder = own ?? input.defaultResultsFolder
      const overridden = own !== undefined
      const root = resolveInsideDir(project.repoPath, resultsFolder)
      const info = await statOrNull(root)
      let results: DataFileListing = EMPTY_LISTING
      if (info !== null) {
        await realPathInside(project.repoPath, root, resultsFolder)
        if (!info.isDirectory()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `The results folder is not a folder: ${resultsFolder}`,
          })
        }
        const structureFile = structureFilePath(ctx.userDataDir)
        const file = await readStructureFile(structureFile)
        const structure = requireStructure(
          effectiveStructureValue(file, project.repoPath),
          structureFile,
        )
        results = await discoverDataFiles(project.repoPath, root, "results", structure)
      }
      const reports = await listReportsFolder(project.repoPath)
      return {
        ...mergeListings(results, reports),
        resultsFolder,
        overridden,
        exists: info !== null,
      }
    }),

  /**
   * Set the project's own results folder from an absolute folder path (the
   * folder picker), stored relative to the project in `metadata.resultsFolder`;
   * `dir: null` removes it so the default from Settings applies again. Only a
   * folder strictly inside the project is accepted (FORBIDDEN otherwise).
   */
  setResultsFolder: publicProcedure
    .input(setResultsFolderInput)
    .mutation(async ({ ctx, input }): Promise<{ resultsFolder: string | null }> => {
      const project = requireProject(ctx.db, input.projectId)
      const { resultsFolder: _old, ...rest } = project.metadata ?? {}
      let resultsFolder: string | null = null
      if (input.dir !== null) {
        if (!isAbsolute(input.dir)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: `The results folder must be an absolute path: ${input.dir}`,
          })
        }
        resultsFolder = await realPathInside(project.repoPath, input.dir, input.dir)
      }
      const metadata: ProjectMetadata = resultsFolder === null ? rest : { ...rest, resultsFolder }
      ctx.db
        .update(projects)
        .set({ metadata, updatedAt: Date.now() })
        .where(eq(projects.id, input.projectId))
        .run()
      return { resultsFolder }
    }),

  /**
   * Return a bounded preview of one repo file, dispatched by its kind. The
   * `relPath` is jailed to the repo (path-traversal guard); a missing file is a
   * clean NOT_FOUND. The preview payload is always size-bounded so a huge file
   * can never balloon the IPC response.
   */
  preview: publicProcedure
    .input(dataPreviewInput)
    .query(async ({ ctx, input }): Promise<DataFilePreview> => {
      const repoPath = requireRepoPath(ctx.db, input.projectId)
      const absPath = resolveInsideDir(repoPath, input.relPath)
      return ctx.analysisPreview.preview({
        absPath,
        relPath: input.relPath,
        load: input.load,
        dataset: input.dataset,
      })
    }),

  /**
   * Size and time of a project PDF, polled by the PDF.js viewer to reload the
   * preview when the file changes. The path is jailed to the project.
   */
  pdfStat: publicProcedure.input(previewInput).query(async ({ ctx, input }): Promise<FileStat> => {
    const repoPath = requireRepoPath(ctx.db, input.projectId)
    return statFile(resolveInsideDir(repoPath, input.relPath))
  }),

  /**
   * The bytes of a project PDF for the bundled PDF.js viewer (the same reader
   * as PDF tabs). The path and its symlink target must stay in the project.
   */
  pdf: publicProcedure.input(previewInput).query(async ({ ctx, input }): Promise<PdfSnapshot> => {
    const repoPath = requireRepoPath(ctx.db, input.projectId)
    return readPdfSnapshot(await insideFile(repoPath, input.relPath))
  }),

  /**
   * Grant the renderer a `pi-lab-media://` URL that streams one project video
   * or gif (with byte ranges, never read whole). The path and its symlink
   * target must stay in the project. `closeMedia` revokes it.
   */
  openMedia: publicProcedure
    .input(previewInput)
    .mutation(async ({ ctx, input }): Promise<{ url: string }> => {
      const kind = classifyDataFile(input.relPath)
      if (kind !== "video" && kind !== "animation") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${input.relPath} is not a video or gif`,
        })
      }
      const repoPath = requireRepoPath(ctx.db, input.projectId)
      const absPath = await insideFile(repoPath, input.relPath)
      if (!(await stat(absPath)).isFile()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Not a file: ${input.relPath}` })
      }
      return { url: analysisMedia.grant(absPath) }
    }),

  /** Revoke a media URL from `openMedia`. Idempotent. */
  closeMedia: publicProcedure
    .input(z.object({ url: z.string().min(1) }))
    .mutation(({ input }): void => {
      analysisMedia.revoke(input.url)
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
