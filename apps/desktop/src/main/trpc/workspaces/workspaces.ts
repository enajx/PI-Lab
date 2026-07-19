import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import {
  getAgentSettingsOrDefaults,
  type PiLabDatabase,
  projects,
  type Workspace,
  type Worktree,
  workspaces,
  worktrees,
} from "@pi-lab/local-db"
import { portBaseForSlot } from "@pi-lab/port-scanner"
import { buildLaunchArgv, getAgent } from "@pi-lab/shared"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { addWorktree, type GitChange, GitError, removeWorktree, status } from "../../git"
import { getOrCreateBranchWorkspace } from "../sessions/sessions"
import { publicProcedure, router } from "../trpc"
import { managedWorktreePath } from "./worktreePath"

/**
 * Workspaces router — a workspace is an agent/editing context within a project,
 * rooted either in its own git worktree (`kind: "worktree"`) or on the project's
 * primary checkout via a branch (`kind: "branch"`). The router owns the git ⇄ DB
 * choreography (create the checkout, then the rows; remove the rows, then the
 * checkout) and launches external CLI agents into the workspace's working dir
 * through the terminal layer.
 */

const createInput = z.object({
  projectId: z.string().min(1),
  kind: z.enum(["worktree", "branch"]),
  name: z.string().min(1),
  /** Branch to operate on. Defaults to a slug of `name` for worktrees. */
  branch: z.string().min(1).optional(),
  /** Branch a new worktree forks from. Defaults to the project's default branch. */
  baseBranch: z.string().min(1).optional(),
})

const idInput = z.object({ id: z.string().min(1) })
const projectIdInput = z.object({ projectId: z.string().min(1) })

const launchAgentInput = z.object({
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  /** Cols/rows for the PTY the agent runs in. */
  cols: z.number().int().positive().default(80),
  rows: z.number().int().positive().default(24),
})

const spawnTerminalInput = z.object({
  workspaceId: z.string().min(1),
  /** Cols/rows for the PTY the shell runs in. */
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
})

/** A login shell is the sensible default when spawning a plain workspace terminal. */
const DEFAULT_SHELL = process.env.SHELL ?? "/bin/bash"

/** A workspace plus the worktree row backing it (null for branch workspaces). */
export interface WorkspaceWithWorktree {
  workspace: Workspace
  worktree: Worktree | null
}

/** Recognize a violation of the "one branch-workspace per project" partial index. */
export function isBranchUniquenessViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message.includes("ux_one_branch_workspace_per_project") ||
    (message.includes("unique constraint failed") && message.includes("workspaces"))
  )
}

/** Inputs to {@link createWorkspace}, the plain workspace-creation routine. */
export interface CreateWorkspaceArgs {
  projectId: string
  kind: "worktree" | "branch"
  name: string
  /** Branch to operate on. Defaults to the project's default branch (branch) or `name` (worktree). */
  branch?: string
  /** Branch a new worktree forks from. Defaults to the project's default branch. */
  baseBranch?: string
}

/**
 * Create a workspace and its backing git checkout — the choreography shared by
 * the `create` procedure and the start-agent-session flow (md/engineering/architecture.md (agent runtime)).
 *
 * For `kind: "worktree"` we compute a managed worktree path under the data dir,
 * `git worktree add` a fresh branch there, and insert matching `worktrees` +
 * `workspaces` rows. For `kind: "branch"` we insert a single workspace on the
 * project's primary checkout; the schema's partial unique index enforces one
 * branch-workspace per project, surfaced here as a clean CONFLICT. Either way a
 * `portBase` is allocated from the project's current workspace count so
 * concurrent workspaces never share dev-server ports.
 */
export async function createWorkspace(
  db: PiLabDatabase,
  args: CreateWorkspaceArgs,
): Promise<WorkspaceWithWorktree> {
  const project = db.select().from(projects).where(eq(projects.id, args.projectId)).get()
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: `No project ${args.projectId}` })
  }

  // Slot index = existing workspace count, so each new workspace gets the next
  // contiguous port block (portBaseForSlot is deterministic arithmetic).
  const slotIndex = db
    .select()
    .from(workspaces)
    .where(eq(workspaces.projectId, project.id))
    .all().length
  const portBase = portBaseForSlot(slotIndex)

  if (args.kind === "branch") {
    const branch = args.branch ?? project.defaultBranch ?? "main"
    try {
      const workspace = db
        .insert(workspaces)
        .values({ projectId: project.id, kind: "branch", name: args.name, branch, portBase })
        .returning()
        .get()
      return { workspace, worktree: null }
    } catch (error) {
      if (isBranchUniquenessViolation(error)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Project ${project.id} already has a branch workspace`,
          cause: error,
        })
      }
      throw error
    }
  }

  // kind === "worktree"
  const branch = args.branch ?? args.name
  const baseBranch = args.baseBranch ?? project.defaultBranch ?? undefined
  const worktreeDir = managedWorktreePath(project.id, branch)

  // Ensure the parent namespace dir exists; `git worktree add` creates the leaf
  // checkout itself but not intermediate directories.
  await mkdir(dirname(worktreeDir), { recursive: true })

  try {
    await addWorktree(project.repoPath, worktreeDir, branch, baseBranch)
  } catch (error) {
    if (error instanceof GitError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error })
    }
    throw error
  }

  const worktree = db
    .insert(worktrees)
    .values({ projectId: project.id, path: worktreeDir, branch, baseBranch })
    .returning()
    .get()

  const workspace = db
    .insert(workspaces)
    .values({
      projectId: project.id,
      worktreeId: worktree.id,
      kind: "worktree",
      name: args.name,
      branch,
      portBase,
    })
    .returning()
    .get()

  return { workspace, worktree }
}

/** The working directory an agent/terminal should run in for a workspace. */
export function workspaceWorkingDir(db: PiLabDatabase, workspace: Workspace): string {
  if (workspace.kind === "worktree") {
    if (!workspace.worktreeId) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Worktree workspace ${workspace.id} has no worktree`,
      })
    }
    const wt = db.select().from(worktrees).where(eq(worktrees.id, workspace.worktreeId)).get()
    if (!wt) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Missing worktree ${workspace.worktreeId}`,
      })
    }
    return wt.path
  }
  // Branch workspaces run on the project's primary checkout.
  const project = db.select().from(projects).where(eq(projects.id, workspace.projectId)).get()
  if (!project) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Missing project ${workspace.projectId}`,
    })
  }
  return project.repoPath
}

export const workspacesRouter = router({
  /**
   * Create a workspace. Delegates the git ⇄ DB choreography to the shared
   * {@link createWorkspace} routine (also used by the start-agent-session flow).
   */
  create: publicProcedure
    .input(createInput)
    .mutation(({ ctx, input }): Promise<WorkspaceWithWorktree> => createWorkspace(ctx.db, input)),

  /** All workspaces in a project, most-recently-active first. */
  list: publicProcedure.input(projectIdInput).query(({ ctx, input }): Workspace[] => {
    return ctx.db.select().from(workspaces).where(eq(workspaces.projectId, input.projectId)).all()
  }),

  /** A single workspace by id, or throws NOT_FOUND. */
  get: publicProcedure.input(idInput).query(({ ctx, input }): Workspace => {
    const row = ctx.db.select().from(workspaces).where(eq(workspaces.id, input.id)).get()
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: `No workspace ${input.id}` })
    }
    return row
  }),

  /**
   * Delete a workspace. For worktree-backed workspaces the managed git worktree
   * is removed from disk first (the DB cascade then drops the `worktrees` row);
   * branch workspaces only forget the row, never touching the project's primary
   * checkout.
   */
  remove: publicProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const workspace = ctx.db.select().from(workspaces).where(eq(workspaces.id, input.id)).get()
    if (!workspace) {
      throw new TRPCError({ code: "NOT_FOUND", message: `No workspace ${input.id}` })
    }

    if (workspace.kind === "worktree" && workspace.worktreeId) {
      const worktree = ctx.db
        .select()
        .from(worktrees)
        .where(eq(worktrees.id, workspace.worktreeId))
        .get()
      const project = ctx.db
        .select()
        .from(projects)
        .where(eq(projects.id, workspace.projectId))
        .get()
      if (worktree && project) {
        try {
          await removeWorktree(project.repoPath, worktree.path)
        } catch (error) {
          if (error instanceof GitError) {
            throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error })
          }
          throw error
        }
      }
    }

    // Drop the workspace row, then its now-orphaned worktree row (the workspace
    // references the worktree, so deleting the workspace first leaves no FK to
    // violate).
    ctx.db.delete(workspaces).where(eq(workspaces.id, workspace.id)).run()
    if (workspace.worktreeId) {
      ctx.db.delete(worktrees).where(eq(worktrees.id, workspace.worktreeId)).run()
    }
    return { ok: true as const }
  }),

  /** Working-tree changes (staged/unstaged/untracked) in the workspace's dir. */
  changes: publicProcedure.input(idInput).query(async ({ ctx, input }): Promise<GitChange[]> => {
    const workspace = ctx.db.select().from(workspaces).where(eq(workspaces.id, input.id)).get()
    if (!workspace) {
      throw new TRPCError({ code: "NOT_FOUND", message: `No workspace ${input.id}` })
    }
    const dir = workspaceWorkingDir(ctx.db, workspace)
    return status(dir)
  }),

  /**
   * Launch an external CLI agent in the workspace's working directory. Resolves
   * the agent from the injected catalog (default `BUILTIN_AGENTS`), builds its
   * argv with the pure `buildLaunchArgv`, and spawns it in a PTY via the shared
   * daemon client (the same path terminals use — md/engineering/architecture.md (agent runtime)). Returns the new
   * session id; the renderer subscribes to `terminal.onData` to render it.
   *
   * Authentication is the agent's own (md/engineering/architecture.md (agent runtime)): we set the agent's `env`
   * if it declares any, but inject no credentials and read none.
   */
  launchAgent: publicProcedure
    .input(launchAgentInput)
    .mutation(async ({ ctx, input }): Promise<{ sessionId: string }> => {
      const workspace = ctx.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId))
        .get()
      if (!workspace) {
        throw new TRPCError({ code: "NOT_FOUND", message: `No workspace ${input.workspaceId}` })
      }

      const agent = getAgent(input.agentId, ctx.agentCatalog)
      if (!agent) {
        throw new TRPCError({ code: "NOT_FOUND", message: `No agent ${input.agentId}` })
      }

      const dir = workspaceWorkingDir(ctx.db, workspace)
      const [catalogCommand, ...args] = buildLaunchArgv(agent)
      const configuredCommand = getAgentSettingsOrDefaults(ctx.db).executableOverrides[
        agent.id
      ]?.trim()
      const candidate = configuredCommand || catalogCommand
      const command = candidate ? await ctx.resolveAgentExecutable(candidate) : null
      if (!command) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `${agent.label} is not available at ${candidate || "(no executable configured)"}. Configure its executable path in Settings → Agents & worktrees.`,
        })
      }

      const client = await ctx.getDaemonClient()
      const launchEnvironment = await ctx.getAgentLaunchEnvironment()
      const session = await client.spawn({
        command,
        args,
        cwd: dir,
        env: { ...launchEnvironment, ...agent.env },
        cols: input.cols,
        rows: input.rows,
      })
      await ctx.activityMonitor.track({
        sessionId: session.id,
        projectId: workspace.projectId,
        workspaceId: workspace.id,
        agentId: agent.id,
        workflowRunId: null,
        turnArmed: false,
        cols: input.cols,
        rows: input.rows,
      })

      // Mark the workspace active so "recent" ordering reflects the launch.
      ctx.db
        .update(workspaces)
        .set({ lastActiveAt: Date.now() })
        .where(eq(workspaces.id, workspace.id))
        .run()

      return { sessionId: session.id }
    }),

  /**
   * Get-or-create the project's single branch-kind workspace (its main checkout).
   * Idempotent: the schema enforces one branch workspace per project, so repeated
   * calls return the same row. Delegates to the shared
   * {@link getOrCreateBranchWorkspace} so the start-agent-session policy and the
   * renderer agree on what "the main checkout" is.
   */
  ensureMain: publicProcedure
    .input(projectIdInput)
    .mutation(
      ({ ctx, input }): Promise<Workspace> => getOrCreateBranchWorkspace(ctx.db, input.projectId),
    ),

  /**
   * Spawn a plain shell PTY in the workspace's working directory. Working-dir
   * resolution stays server-side (the renderer never handles raw paths): we look
   * up the workspace, resolve its cwd by kind via {@link workspaceWorkingDir}, and
   * start the user's login shell in it through the shared daemon client — the same
   * path `terminal.spawn` uses when given no command. Returns the new session id.
   */
  spawnTerminal: publicProcedure
    .input(spawnTerminalInput)
    .mutation(async ({ ctx, input }): Promise<{ sessionId: string }> => {
      const workspace = ctx.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId))
        .get()
      if (!workspace) {
        throw new TRPCError({ code: "NOT_FOUND", message: `No workspace ${input.workspaceId}` })
      }

      const dir = workspaceWorkingDir(ctx.db, workspace)
      const client = await ctx.getDaemonClient()
      const launchEnvironment = await ctx.getAgentLaunchEnvironment()
      const session = await client.spawn({
        command: DEFAULT_SHELL,
        cwd: dir,
        env: launchEnvironment,
        cols: input.cols,
        rows: input.rows,
      })
      await ctx.activityMonitor.trackTerminal({
        sessionId: session.id,
        projectId: workspace.projectId,
        workspaceId: workspace.id,
        label: "Terminal",
        cols: input.cols,
        rows: input.rows,
      })

      // Mark the workspace active so "recent" ordering reflects the launch.
      ctx.db
        .update(workspaces)
        .set({ lastActiveAt: Date.now() })
        .where(eq(workspaces.id, workspace.id))
        .run()

      return { sessionId: session.id }
    }),
})
