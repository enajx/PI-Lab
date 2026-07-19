import { relative } from "node:path"
import { type PiLabDatabase, type Workspace, workspaces } from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import { z } from "zod"
import {
  type Diagnostic,
  type DiagnosticsResult,
  type PyToolsExec,
  runFormat,
  runLint,
  runTypeCheck,
} from "../../diagnostics"
import { resolveWorkspacePythonRuntime } from "../../python"
import { resolveInsideDir } from "../files"
import { publicProcedure, router } from "../trpc"
import { workspaceWorkingDir } from "../workspaces/workspaces"

/**
 * Diagnostics router — the built-in editor's Python code intelligence over tRPC
 * (AGENTS.md "Scope", TODO "Built-in editor"). v1 runs the Astral tools as **one-shot
 * CLIs** (NOT LSP): on save the editor calls `check` to type-check (`ty`,
 * toggleable to `pyrefly`) and optionally lint (`ruff`), and `format` for
 * format-on-save. Diagnostics come back in the normalized {@link Diagnostic}
 * shape so the editor draws squiggles / gutter markers / a status count from one
 * list.
 *
 * The router stays thin (md/engineering/testing-and-build.md): it resolves the workspace working dir,
 * jails `relPath` to it (reusing the files router's traversal guard), and
 * delegates to the pure runners over the injected {@link PyToolsExec}. It operates
 * on the **saved file on disk** — the editor saves before/at check and passes the
 * same `relPath` — so there is no temp-file write here. Every tool call is
 * graceful when `uv`/`ty`/`ruff` is absent: the result reports
 * `toolsAvailable: false` + `missing[]` and an empty list, never an error.
 */

const checkInput = z.object({
  workspaceId: z.string().min(1),
  /** Path (relative to the workspace working dir) of the *saved* file to check. */
  relPath: z.string().min(1),
  /** Which type checker to run (AGENTS.md "Scope" — settings toggle). */
  typeChecker: z.enum(["ty", "pyrefly"]),
  /** Whether to also run the ruff linter. */
  lint: z.boolean(),
})

const formatInput = z.object({
  workspaceId: z.string().min(1),
  relPath: z.string().min(1),
})

/** Outcome of a format-on-save call: whether ruff ran and whether it rewrote the file. */
export interface FormatResult {
  /** Whether `ruff format` was found and ran (false ⇒ ruff/`uv` absent). */
  toolsAvailable: boolean
  /** Whether the file on disk changed, so the editor knows to reload its buffer. */
  changed: boolean
  /** Names of the absent tools (`["ruff"]` when unavailable), else empty. */
  missing: string[]
}

/** Fetch a workspace row or throw a clean NOT_FOUND (mirrors the files router). */
function requireWorkspace(db: PiLabDatabase, workspaceId: string): Workspace {
  const row = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get()
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: `No workspace ${workspaceId}` })
  }
  return row
}

/**
 * Resolve + jail `relPath` to the workspace working dir, returning both the
 * working dir (the tools' cwd, so they find the project's config/venv) and the
 * file path expressed *relative to it* (what we pass to the CLI, keeping
 * tool-reported paths stable). The guard rejects absolute paths and `..` escapes
 * with FORBIDDEN before any exec runs.
 */
function resolveTarget(
  db: PiLabDatabase,
  workspaceId: string,
  relPath: string,
): { cwd: string; fileArg: string; pythonEnvironmentPath: string | null } {
  const workspace = requireWorkspace(db, workspaceId)
  const cwd = workspaceWorkingDir(db, workspace)
  const absolute = resolveInsideDir(cwd, relPath)
  // Pass a path relative to cwd so the tool's own output paths stay tidy; the
  // guard already proved it can't escape, so this relative form stays inside.
  return {
    cwd,
    fileArg: relative(cwd, absolute),
    pythonEnvironmentPath: workspace.pythonEnvironmentPath,
  }
}

/**
 * Run the requested checks and merge into one {@link DiagnosticsResult}. Each
 * tool runs independently; a missing one contributes no diagnostics and lands in
 * `missing[]` (so the editor can prompt to install it) while the present ones
 * still report normally. `toolsAvailable` is true iff every requested tool ran.
 */
async function runChecks(
  exec: PyToolsExec,
  params: { fileArg: string; cwd: string; typeChecker: "ty" | "pyrefly"; lint: boolean },
): Promise<DiagnosticsResult> {
  const { fileArg, cwd, typeChecker, lint } = params

  const tasks: Promise<{ diagnostics: Diagnostic[]; available: boolean; tool: string }>[] = [
    runTypeCheck(exec, typeChecker, fileArg, cwd).then((r) => ({ ...r, tool: typeChecker })),
  ]
  if (lint) {
    tasks.push(runLint(exec, fileArg, cwd).then((r) => ({ ...r, tool: "ruff" })))
  }

  const results = await Promise.all(tasks)

  const diagnostics: Diagnostic[] = []
  const missing: string[] = []
  for (const result of results) {
    if (result.available) diagnostics.push(...result.diagnostics)
    else missing.push(result.tool)
  }

  return { diagnostics, toolsAvailable: missing.length === 0, missing }
}

export const diagnosticsRouter = router({
  /**
   * Type-check (and optionally lint) the saved file, returning normalized
   * diagnostics plus a tooling-availability signal. Never throws for absent
   * tools — that's the `toolsAvailable: false` / `missing[]` path.
   */
  check: publicProcedure
    .input(checkInput)
    .query(async ({ ctx, input }): Promise<DiagnosticsResult> => {
      const { cwd, fileArg, pythonEnvironmentPath } = resolveTarget(
        ctx.db,
        input.workspaceId,
        input.relPath,
      )
      const runtime = await resolveWorkspacePythonRuntime(
        ctx.resolvePythonRuntime,
        cwd,
        pythonEnvironmentPath,
      )
      const exec: PyToolsExec = (params) => ctx.pyToolsExec({ ...params, runtime })
      return runChecks(exec, {
        fileArg,
        cwd,
        typeChecker: input.typeChecker,
        lint: input.lint,
      })
    }),

  /**
   * Format the saved file in place with `ruff format` (AGENTS.md "Scope", TODO
   * "Built-in editor" — format-on-save, off by default). Reports whether the
   * file changed so the editor reloads its buffer only when needed. Graceful
   * when ruff/`uv` is absent (`toolsAvailable: false`, `missing: ["ruff"]`).
   */
  format: publicProcedure
    .input(formatInput)
    .mutation(async ({ ctx, input }): Promise<FormatResult> => {
      const { cwd, fileArg, pythonEnvironmentPath } = resolveTarget(
        ctx.db,
        input.workspaceId,
        input.relPath,
      )
      const runtime = await resolveWorkspacePythonRuntime(
        ctx.resolvePythonRuntime,
        cwd,
        pythonEnvironmentPath,
      )
      const result = await runFormat(
        (params) => ctx.pyToolsExec({ ...params, runtime }),
        fileArg,
        cwd,
      )
      return {
        toolsAvailable: result.available,
        changed: result.changed,
        missing: result.available ? [] : ["ruff"],
      }
    }),
})
