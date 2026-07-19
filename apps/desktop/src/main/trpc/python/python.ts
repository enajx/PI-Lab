import { existsSync } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"
import { type PiLabDatabase, type Workspace, workspaces } from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import { z } from "zod"
import {
  environmentDirForInterpreter,
  type PythonEnvironmentManager,
  type PythonRuntime,
  resolveWorkspacePythonRuntime,
} from "../../python"
import type { AppContext } from "../context"
import { resolveInsideDir } from "../files"
import { publicProcedure, router } from "../trpc"
import { workspaceWorkingDir } from "../workspaces/workspaces"

const workspaceInput = z.object({ workspaceId: z.string().min(1) })
const selectEnvironmentInput = workspaceInput.extend({
  path: z.string().min(1).nullable(),
})
const runFileInput = z.object({
  workspaceId: z.string().min(1),
  relPath: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
})

function requireWorkspace(db: PiLabDatabase, workspaceId: string): Workspace {
  const workspace = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get()
  if (!workspace) {
    throw new TRPCError({ code: "NOT_FOUND", message: `No workspace ${workspaceId}` })
  }
  return workspace
}

export interface PythonEnvironmentOption {
  path: string
  displayName: string
  interpreterPath: string
}

async function resolveWorkspaceRuntime(
  ctx: AppContext,
  workspace: Workspace,
  cwd: string,
): Promise<PythonRuntime> {
  return resolveWorkspacePythonRuntime(
    ctx.resolvePythonRuntime,
    cwd,
    workspace.pythonEnvironmentPath,
  )
}

export const pythonRouter = router({
  resolve: publicProcedure
    .input(workspaceInput)
    .query(async ({ ctx, input }): Promise<PythonRuntime> => {
      const workspace = requireWorkspace(ctx.db, input.workspaceId)
      const cwd = workspaceWorkingDir(ctx.db, workspace)
      return resolveWorkspaceRuntime(ctx, workspace, cwd)
    }),

  /** Valid current/project choices first, then shallow manager-owned globals. */
  options: publicProcedure
    .input(workspaceInput)
    .query(async ({ ctx, input }): Promise<PythonEnvironmentOption[]> => {
      const workspace = requireWorkspace(ctx.db, input.workspaceId)
      const cwd = workspaceWorkingDir(ctx.db, workspace)
      const current = await resolveWorkspaceRuntime(ctx, workspace, cwd)
      const candidatePaths = [join(cwd, ".venv"), join(cwd, "venv")]
      if (current.source !== null && current.interpreterPath) {
        candidatePaths.unshift(
          workspace.pythonEnvironmentPath ?? environmentDirForInterpreter(current.interpreterPath),
        )
      }

      const options: PythonEnvironmentOption[] = []
      const seenInterpreters = new Set<string>()
      for (const path of candidatePaths) {
        const runtime = await ctx.resolvePythonRuntime(cwd, path)
        if (runtime.source !== "selected" || !runtime.interpreterPath) continue
        const canonicalInterpreter = await canonicalInterpreterPath(runtime.interpreterPath)
        if (!canonicalInterpreter || seenInterpreters.has(canonicalInterpreter)) continue
        seenInterpreters.add(canonicalInterpreter)
        options.push({
          path,
          displayName: runtime.displayName,
          interpreterPath: runtime.interpreterPath,
        })
      }

      const globalCandidates = await ctx.discoverPythonEnvironments()
      for (const candidate of globalCandidates) {
        const runtime = await ctx.resolvePythonRuntime(cwd, candidate.path)
        if (runtime.source !== "selected" || !runtime.interpreterPath) continue
        const canonicalInterpreter = await canonicalInterpreterPath(runtime.interpreterPath)
        if (!canonicalInterpreter || seenInterpreters.has(canonicalInterpreter)) continue
        seenInterpreters.add(canonicalInterpreter)
        options.push({
          path: candidate.path,
          displayName: `${managerDisplayName(candidate.manager)} · ${runtime.displayName}`,
          interpreterPath: runtime.interpreterPath,
        })
      }
      return options
    }),

  /**
   * Cheap active-editor refresh: only inspect `.venv` and `venv`, avoiding
   * repeated Poetry/uv/PATH process probes while no environment exists.
   */
  resolveLocal: publicProcedure
    .input(workspaceInput)
    .query(async ({ ctx, input }): Promise<PythonRuntime | null> => {
      const workspace = requireWorkspace(ctx.db, input.workspaceId)
      const cwd = workspaceWorkingDir(ctx.db, workspace)
      const candidates = [
        { path: join(cwd, ".venv"), source: "dot-venv" as const },
        { path: join(cwd, "venv"), source: "venv" as const },
      ]
      for (const { path, source } of candidates) {
        const runtime = await ctx.resolvePythonRuntime(cwd, path)
        if (runtime.source === "selected") return { ...runtime, source }
      }
      return null
    }),

  select: publicProcedure
    .input(selectEnvironmentInput)
    .mutation(async ({ ctx, input }): Promise<PythonRuntime> => {
      const workspace = requireWorkspace(ctx.db, input.workspaceId)
      const cwd = workspaceWorkingDir(ctx.db, workspace)
      if (input.path !== null && !isAbsolute(input.path)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Python environment selection must be an absolute path",
        })
      }
      if (input.path !== null) {
        const selected = await ctx.resolvePythonRuntime(cwd, input.path)
        if (selected.source !== "selected") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "The selected path is not a working Python environment or interpreter",
          })
        }
      }
      ctx.db
        .update(workspaces)
        .set({ pythonEnvironmentPath: input.path, updatedAt: Date.now() })
        .where(eq(workspaces.id, workspace.id))
        .run()
      return resolveWorkspacePythonRuntime(ctx.resolvePythonRuntime, cwd, input.path)
    }),

  runFile: publicProcedure
    .input(runFileInput)
    .mutation(async ({ ctx, input }): Promise<{ sessionId: string; runtime: PythonRuntime }> => {
      const workspace = requireWorkspace(ctx.db, input.workspaceId)
      const cwd = workspaceWorkingDir(ctx.db, workspace)
      const lexicalFile = resolveInsideDir(cwd, input.relPath)
      if (!existsSync(lexicalFile)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Python file does not exist" })
      }
      const [realCwd, absoluteFile] = await Promise.all([realpath(cwd), realpath(lexicalFile)])
      const fileArg = relative(realCwd, absoluteFile)
      if (
        fileArg === "" ||
        fileArg === ".." ||
        fileArg.startsWith(`..${sep}`) ||
        isAbsolute(fileArg)
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Path escapes the workspace directory: ${input.relPath}`,
        })
      }
      if (!(await stat(absoluteFile)).isFile()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Run Python requires a file" })
      }
      if (!/\.pyi?$/i.test(fileArg)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Run Python requires a Python file" })
      }

      const runtime = await resolveWorkspacePythonRuntime(
        ctx.resolvePythonRuntime,
        realCwd,
        workspace.pythonEnvironmentPath,
      )
      const command = runtime.runStrategy.command
      if (!command) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No Python interpreter or uv runtime is available",
        })
      }
      const client = await ctx.getDaemonClient()
      const session = await client.spawn({
        command,
        args: [...runtime.runStrategy.argsPrefix, fileArg],
        cwd: realCwd,
        cols: input.cols,
        rows: input.rows,
      })
      ctx.db
        .update(workspaces)
        .set({ lastActiveAt: Date.now() })
        .where(eq(workspaces.id, workspace.id))
        .run()
      return { sessionId: session.id, runtime }
    }),
})

async function canonicalInterpreterPath(interpreterPath: string): Promise<string | null> {
  try {
    return await realpath(interpreterPath)
  } catch (cause) {
    if (!(cause instanceof Error) || !("code" in cause)) throw cause
    const code = (cause as NodeJS.ErrnoException).code
    // A candidate can disappear between the successful interpreter probe and
    // canonicalization; omit that stale menu entry.
    if (code === "ENOENT" || code === "ENOTDIR") return null
    if (code === "EACCES" || code === "EPERM") return null
    throw cause
  }
}

function managerDisplayName(manager: PythonEnvironmentManager): string {
  switch (manager) {
    case "pyenv":
      return "pyenv"
    case "conda":
      return "Conda"
    case "poetry":
      return "Poetry"
    case "uv":
      return "uv"
    case "virtualenvwrapper":
      return "virtualenvwrapper"
  }
}
