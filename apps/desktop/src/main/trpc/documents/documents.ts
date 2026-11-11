import { readFile, realpath } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import { type PiLabDatabase, projects, resolveDataDir } from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import { z } from "zod"
import {
  documentPython,
  hasPythonCode,
  PI_LAB_JUPYTER_VENV,
  withDocumentPython,
} from "../../documents/documentPython"
import {
  type DocumentToolInstallStage,
  downloadArtifact,
  installMystmd,
  installQuarto,
  QUARTO_MACOS_ARTIFACT,
} from "../../documents/install"
import {
  excludeRenderFolder,
  findQuartoProject,
  RENDER_FOLDER,
  renderPlan,
  runRender,
} from "../../documents/render"
import {
  type DocumentTool,
  type FoundDocumentTool,
  findDocumentTool,
  WELL_KNOWN_TOOL_DIRS,
} from "../../documents/tools"
import type { AppContext } from "../context"
import { resolveInsideDir } from "../files/files"
import { assertPathInside } from "../science/analysis/interactive"
import { publicProcedure, router } from "../trpc"

/**
 * Document tools router: find Quarto and MyST (mystmd), install them into PI
 * Lab's tools folder (`<data folder>/tools`) on request, render a .qmd or a
 * MyST .md to HTML, and open the rendered page in the default browser.
 */

const TOOL_NAMES: Readonly<Record<DocumentTool, string>> = { quarto: "Quarto", myst: "MyST" }
/** A render with code blocks can take long; stop it after 15 minutes. */
const RENDER_TIMEOUT_MS = 15 * 60_000

export type DocumentInstallState = "idle" | DocumentToolInstallStage | "complete" | "failed"
export interface DocumentInstallStatus {
  state: DocumentInstallState
  /** 0 to 100, or null when the stage has no measurable progress. */
  progress: number | null
  message: string
  error: string | null
}
interface InstallJob {
  status: DocumentInstallStatus
  pending: boolean
}
const jobs = new WeakMap<PiLabDatabase, Record<DocumentTool, InstallJob>>()

/** Keep install progress separate for each app database, including isolated tests. */
function jobsFor(db: PiLabDatabase): Record<DocumentTool, InstallJob> {
  let found = jobs.get(db)
  if (!found) {
    const idle = (): InstallJob => ({
      pending: false,
      status: { state: "idle", progress: null, message: "", error: null },
    })
    found = { quarto: idle(), myst: idle() }
    jobs.set(db, found)
  }
  return found
}

function toolsDir(): string {
  return join(resolveDataDir(), "tools")
}

async function findTool(ctx: AppContext, tool: DocumentTool): Promise<FoundDocumentTool | null> {
  return findDocumentTool(
    tool,
    toolsDir(),
    await ctx.getAgentLaunchEnvironment(),
    WELL_KNOWN_TOOL_DIRS,
  )
}

/** The tool that renders `relPath`: Quarto for .qmd, MyST for .md. */
function toolForFile(relPath: string): DocumentTool {
  const lower = relPath.toLowerCase()
  if (lower.endsWith(".qmd")) return "quarto"
  if (lower.endsWith(".md")) return "myst"
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: `Only Quarto (.qmd) or MyST (.md) files can be rendered: ${relPath}`,
  })
}

function projectFolder(db: PiLabDatabase, projectId: string): string {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: `No project ${projectId}` })
  return project.repoPath
}

/**
 * The project folder and the real path of `relPath` in it (symlinks resolved),
 * refused when that real path is outside the project folder.
 */
async function realFileInProject(
  db: PiLabDatabase,
  projectId: string,
  relPath: string,
): Promise<{ folder: string; abs: string }> {
  const folder = await realpath(projectFolder(db, projectId))
  const abs = await realpath(resolveInsideDir(folder, relPath))
  assertPathInside(folder, abs)
  return { folder, abs }
}

const STAGE_MESSAGES: Readonly<Record<DocumentToolInstallStage, string>> = {
  downloading: "Downloading…",
  extracting: "Extracting…",
  validating: "Checking the installed command…",
  installing: "Installing with npm…",
}

/** Install one tool after the explicit Install click, recording progress in `job`. */
async function installTool(ctx: AppContext, tool: DocumentTool, job: InstallJob): Promise<void> {
  const env = await ctx.getAgentLaunchEnvironment()
  const onProgress = (stage: DocumentToolInstallStage, fraction: number | null) => {
    job.status = {
      state: stage,
      progress: fraction === null ? null : Math.round(fraction * 100),
      message: `${TOOL_NAMES[tool]}: ${STAGE_MESSAGES[stage]}`,
      error: null,
    }
  }
  const path =
    tool === "quarto"
      ? await installQuarto({
          toolsDir: toolsDir(),
          platform: process.platform,
          artifact: QUARTO_MACOS_ARTIFACT,
          download: downloadArtifact,
          onProgress,
        })
      : await installMystmd({
          toolsDir: toolsDir(),
          npmPath: await ctx.resolveAgentExecutable("npm"),
          env,
          onProgress,
        })
  job.status = {
    state: "complete",
    progress: 100,
    message: `${TOOL_NAMES[tool]} is installed: ${path}`,
    error: null,
  }
}

const toolInput = z.object({ tool: z.enum(["quarto", "myst"]) })
const fileInput = z.object({ projectId: z.string().min(1), relPath: z.string().min(1) })

export const documentsRouter = router({
  /** What is found for quarto and myst (path and version, or null), and install progress. */
  tools: publicProcedure.query(async ({ ctx }) => {
    const [quarto, myst] = await Promise.all([findTool(ctx, "quarto"), findTool(ctx, "myst")])
    const job = jobsFor(ctx.db)
    return {
      quarto,
      myst,
      installation: { quarto: job.quarto.status, myst: job.myst.status },
    }
  }),

  /** Start installing a tool into PI Lab's tools folder; poll `tools` for progress. */
  install: publicProcedure.input(toolInput).mutation(({ ctx, input }) => {
    const job = jobsFor(ctx.db)[input.tool]
    if (job.pending) return { started: false }
    job.pending = true
    job.status = {
      state: "downloading",
      progress: null,
      message: `${TOOL_NAMES[input.tool]}: Starting…`,
      error: null,
    }
    void installTool(ctx, input.tool, job)
      .catch((error: unknown) => {
        job.status = {
          state: "failed",
          progress: null,
          message: `${TOOL_NAMES[input.tool]} installation failed.`,
          error: error instanceof Error ? error.message : String(error),
        }
      })
      .finally(() => {
        job.pending = false
      })
    return { started: true }
  }),

  /**
   * Render a .qmd with Quarto or a .md with MyST into `_render/` next to it.
   * Returns the build log, and the rendered HTML's path (relative to the
   * project) when the render worked.
   */
  render: publicProcedure.input(fileInput).mutation(async ({ ctx, input }) => {
    const tool = toolForFile(input.relPath)
    const { folder, abs: absFile } = await realFileInProject(ctx.db, input.projectId, input.relPath)
    const quartoProject = tool === "quarto" ? findQuartoProject(absFile, folder) : null
    const found = await findTool(ctx, tool)
    if (!found)
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `${TOOL_NAMES[tool]} was not found. Install it from the Render button or Settings > Document tools.`,
      })
    await excludeRenderFolder(
      absFile,
      tool === "quarto" ? (quartoProject ?? dirname(absFile)) : null,
    )
    const launchEnv = await ctx.getAgentLaunchEnvironment()
    const python = hasPythonCode(tool, await readFile(absFile, "utf8"))
      ? await documentPython({
          projectDir: folder,
          venvDir: join(toolsDir(), PI_LAB_JUPYTER_VENV),
          searchPath: launchEnv.PATH ?? "",
          platform: process.platform,
          env: launchEnv,
        })
      : { python: null, log: "" }
    const env = withDocumentPython(launchEnv, python.python)
    const outcome = await runRender(
      renderPlan(tool, found.path, absFile, quartoProject),
      env,
      RENDER_TIMEOUT_MS,
    )
    return {
      tool,
      ok: outcome.ok,
      log: python.log ? `${python.log}\n\n${outcome.log}` : outcome.log,
      outputRelPath: outcome.outputPath
        ? relative(folder, outcome.outputPath).split(sep).join("/")
        : null,
    }
  }),

  /**
   * Open a rendered page of the project with the system's default app (the
   * browser): only an .html file inside a `_render` folder (where renders write).
   */
  openInBrowser: publicProcedure.input(fileInput).mutation(async ({ ctx, input }) => {
    const { folder, abs } = await realFileInProject(ctx.db, input.projectId, input.relPath)
    const parts = relative(folder, abs).split(sep)
    if (!abs.toLowerCase().endsWith(".html") || !parts.slice(0, -1).includes(RENDER_FOLDER)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Only rendered .html pages in a ${RENDER_FOLDER} folder can be opened: ${input.relPath}`,
      })
    }
    const error = await ctx.openPath(abs)
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error })
  }),
})
