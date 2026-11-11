import { execFile } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import { delimiter, extname, relative, sep } from "node:path"
import { type PiLabDatabase, type Workspace, workspaces } from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import { z } from "zod"
import {
  addToolArgs,
  canAddToolToProject,
  findExecutable,
  type PythonTool,
  resolvePythonToolEnvironment,
  UV_INSTALL_HINT,
} from "../../notebooks/pythonEnv"
import type { AppContext } from "../context"
import { resolveInsideDir } from "../files"
import { isMarimoNotebookFile } from "../science/analysis/discover"
import { assertPathInside } from "../science/analysis/interactive"
import { publicProcedure, router } from "../trpc"
import { workspaceWorkingDir } from "../workspaces/workspaces"

/**
 * marimo and Jupyter notebooks on their own local server, shown in a PI Lab tab.
 * The server processes live in Electron main (`ctx.notebookServers`); the renderer
 * gets the URL and stops the server by the id it chose for its tab.
 */

const startInput = z.object({
  workspaceId: z.string().min(1),
  relPath: z.string().min(1),
  serverId: z.string().min(1),
})
const serverInput = z.object({ serverId: z.string().min(1) })
const addInput = z.object({
  workspaceId: z.string().min(1),
  tool: z.enum(["marimo", "jupyter"]),
})

export interface StartedNotebook {
  url: string
  tool: PythonTool
  /** Which Python runs the notebook, e.g. "Project environment (.venv)". */
  environmentLabel: string
  /** True when the tool came from a PI Lab copy and `uv add` can add it to the project. */
  canAddToProject: boolean
}

export interface AddToProjectResult {
  ok: boolean
  /** The command that ran and its combined output, or why it could not run. */
  output: string
}

const ADD_TIMEOUT_MS = 10 * 60_000

function requireWorkspace(db: PiLabDatabase, workspaceId: string): Workspace {
  const workspace = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get()
  if (!workspace) {
    throw new TRPCError({ code: "NOT_FOUND", message: `No workspace ${workspaceId}` })
  }
  return workspace
}

/**
 * PATH for finding uv and for the server: PI Lab's own PATH first (so a test can put
 * stand-ins first), then the login shell's PATH (a GUI launch has a short PATH).
 */
async function launchEnvironment(ctx: AppContext): Promise<NodeJS.ProcessEnv> {
  const login = await ctx.getAgentLaunchEnvironment()
  const path = [process.env.PATH ?? "", login.PATH ?? ""].filter(Boolean).join(delimiter)
  return { ...login, PATH: path }
}

async function notebookTool(absPath: string, relPath: string): Promise<PythonTool> {
  const extension = extname(absPath).toLowerCase()
  if (extension === ".ipynb") return "jupyter"
  if (extension === ".py" && (await isMarimoNotebookFile(absPath))) return "marimo"
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: `${relPath} is not a Jupyter or marimo notebook`,
  })
}

export const notebooksRouter = router({
  /**
   * Start the notebook's server in the project's environment (or a PI Lab copy
   * through uvx) and return the URL for its tab. Fails with a clear message when
   * uv is needed and missing, or when the server stops before it is ready.
   */
  start: publicProcedure
    .input(startInput)
    .mutation(async ({ ctx, input }): Promise<StartedNotebook> => {
      const workspace = requireWorkspace(ctx.db, input.workspaceId)
      const cwd = await realpath(workspaceWorkingDir(ctx.db, workspace))
      const absPath = await realpath(resolveInsideDir(cwd, input.relPath))
      assertPathInside(cwd, absPath)
      if (!(await stat(absPath)).isFile()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `${input.relPath} is not a file` })
      }
      const tool = await notebookTool(absPath, input.relPath)
      const env = await launchEnvironment(ctx)
      const environment = await resolvePythonToolEnvironment({
        projectDir: cwd,
        tool,
        selectedEnvironmentPath: workspace.pythonEnvironmentPath,
        searchPath: env.PATH ?? "",
        platform: process.platform,
      })
      if (environment.kind === "no-uv") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: environment.message })
      }
      const { url } = await ctx.notebookServers.start({
        serverId: input.serverId,
        tool,
        environment,
        cwd,
        absPath,
        relPath: relative(cwd, absPath).split(sep).join("/"),
        env,
      })
      return {
        url,
        tool,
        environmentLabel:
          environment.kind !== "project" && environment.fallbackReason
            ? `${environment.label}. The project's Python was not used: ${environment.fallbackReason}`
            : environment.label,
        canAddToProject: environment.kind === "pi-lab" && (await canAddToolToProject(cwd)),
      }
    }),

  /** Stop a tab's server (also one still starting). Idempotent. */
  stop: publicProcedure.input(serverInput).mutation(async ({ ctx, input }): Promise<void> => {
    await ctx.notebookServers.stop(input.serverId)
  }),

  /** Open a running tab's notebook in the system browser. */
  openInBrowser: publicProcedure
    .input(serverInput)
    .mutation(async ({ ctx, input }): Promise<void> => {
      await ctx.notebookServers.openInBrowser(input.serverId)
    }),

  /**
   * Add marimo (or JupyterLab and ipykernel) to the project as a dev dependency
   * with `uv add --dev`. Only on the user's request; returns the output either way.
   */
  addToProject: publicProcedure
    .input(addInput)
    .mutation(async ({ ctx, input }): Promise<AddToProjectResult> => {
      const workspace = requireWorkspace(ctx.db, input.workspaceId)
      const cwd = workspaceWorkingDir(ctx.db, workspace)
      if (!(await canAddToolToProject(cwd))) {
        return { ok: false, output: "This project has no pyproject.toml, so uv cannot add to it." }
      }
      const env = await launchEnvironment(ctx)
      const uv = await findExecutable("uv", env.PATH ?? "", process.platform)
      if (!uv) return { ok: false, output: `uv was not found. ${UV_INSTALL_HINT}` }
      const args = addToolArgs(input.tool)
      return new Promise((resolveAdd) => {
        execFile(
          uv,
          args,
          { cwd, env, timeout: ADD_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const output = [`$ uv ${args.join(" ")}`, stdout.trim(), stderr.trim()]
            if (error && !stdout && !stderr) output.push(error.message)
            resolveAdd({ ok: !error, output: output.filter(Boolean).join("\n") })
          },
        )
      })
    }),
})
