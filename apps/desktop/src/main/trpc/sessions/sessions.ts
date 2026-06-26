import {
  getSettingsOrDefaults,
  projects,
  type SkipperDatabase,
  type Workspace,
  workspaces,
} from "@skipper/local-db"
import { buildLaunchArgv, getAgent } from "@skipper/shared"
import { TRPCError } from "@trpc/server"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import type { AppContext } from "../context"
import { publicProcedure, router } from "../trpc"
import { createWorkspace, workspaceWorkingDir } from "../workspaces"

/**
 * Sessions router — the "start agent session" flow (docs/architecture.md (agent runtime), P5b).
 *
 * Opening an agent session must, by default, behave like opening a normal
 * terminal in the project's *main checkout* (cwd = repo root, no new worktree).
 * The git-worktree feature stays fully supported but is opt-in / automatic on
 * concurrency rather than the default. This router decides the workspace kind,
 * gets-or-creates the backing workspace, launches the agent into the correct
 * working directory, and records the live session so a *second* concurrent
 * agent for the same project is steered onto its own worktree.
 *
 * It sits *above* `workspaces.create` (which still takes an explicit `kind`) and
 * reuses that creation choreography + the cwd-by-kind resolver, so the only new
 * logic here is the policy and the live-session bookkeeping.
 */

const startInput = z.object({
  projectId: z.string().min(1),
  agentId: z.string().min(1),
  /** Display name for a freshly-created worktree workspace. Defaulted when omitted. */
  name: z.string().min(1).optional(),
  /** Cols/rows for the PTY the agent runs in. */
  cols: z.number().int().positive().default(80),
  rows: z.number().int().positive().default(24),
})

/** Which kind of workspace an agent session was opened in. */
export type SessionKind = Workspace["kind"]

export interface StartSessionResult {
  sessionId: string
  workspaceId: string
  kind: SessionKind
}

/**
 * Decide the workspace kind for a new agent session, per docs/architecture.md (agent runtime):
 *   1. `worktreePerAgent` ON   → always a fresh worktree;
 *   2. a live agent already runs for this project (2nd+ concurrent) → fresh
 *      worktree, so it can't clobber the shared main checkout;
 *   3. otherwise                → the project's single branch workspace (main checkout).
 */
export function decideSessionKind(worktreePerAgent: boolean, liveAgentCount: number): SessionKind {
  if (worktreePerAgent) return "worktree"
  if (liveAgentCount > 0) return "worktree"
  return "branch"
}

/**
 * Get-or-create the project's single branch-kind workspace (its main checkout).
 * The schema enforces at most one branch workspace per project, so on a second
 * branch-eligible start we must reuse the existing row rather than insert a
 * conflicting one. A name is derived from the project when creating.
 */
export async function getOrCreateBranchWorkspace(
  db: SkipperDatabase,
  projectId: string,
): Promise<Workspace> {
  const existing = db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.projectId, projectId), eq(workspaces.kind, "branch")))
    .get()
  if (existing) return existing

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: `No project ${projectId}` })
  }
  const { workspace } = await createWorkspace(db, {
    projectId,
    kind: "branch",
    name: project.name,
  })
  return workspace
}

/**
 * A unique, human-recognizable worktree branch/name for a concurrent agent
 * session. Time-based so repeated starts never collide on the managed worktree
 * path (which is namespaced by a slug of the branch).
 */
function freshWorktreeName(requested?: string): string {
  if (requested) return requested
  return `agent-${Date.now().toString(36)}`
}

/** Arguments for {@link startAgentSession} — the plain-function start flow. */
export interface StartAgentSessionInput {
  projectId: string
  agentId: string
  /** Display name for a freshly-created worktree workspace. Defaulted when omitted. */
  name?: string
  /** Optional prompt passed to the agent as a final positional argument. */
  prompt?: string
  cols?: number
  rows?: number
}

/**
 * The "start agent session" flow as a plain function over {@link AppContext}, so
 * both the `sessions.start` mutation *and* the automations dispatcher fire agents
 * through the exact same policy path (docs/architecture.md, agent runtime; no duplicated launch logic). It decides
 * the workspace kind, gets-or-creates that workspace, launches the agent in the
 * correct cwd, registers the live session, and marks the workspace active.
 *
 * A `prompt` (used by automations) is appended as the agent's final positional
 * argument, after its catalog `defaultArgs` — agents like Claude Code / Codex
 * accept an initial prompt that way.
 */
export async function startAgentSession(
  ctx: AppContext,
  input: StartAgentSessionInput,
): Promise<StartSessionResult> {
  const project = ctx.db.select().from(projects).where(eq(projects.id, input.projectId)).get()
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.projectId}` })
  }

  const agent = getAgent(input.agentId, ctx.agentCatalog)
  if (!agent) {
    throw new TRPCError({ code: "NOT_FOUND", message: `No agent ${input.agentId}` })
  }

  const { worktreePerAgent } = getSettingsOrDefaults(ctx.db)
  const liveCount = ctx.liveAgents.liveAgentCount(project.id)
  const kind = decideSessionKind(worktreePerAgent, liveCount)

  const workspace =
    kind === "branch"
      ? await getOrCreateBranchWorkspace(ctx.db, project.id)
      : (
          await createWorkspace(ctx.db, {
            projectId: project.id,
            kind: "worktree",
            name: freshWorktreeName(input.name),
          })
        ).workspace

  // Resolve cwd by kind: repo root for branch, worktree path for worktree.
  const dir = workspaceWorkingDir(ctx.db, workspace)
  const promptArgs = input.prompt?.trim() ? [input.prompt] : []
  const [command, ...args] = buildLaunchArgv(agent, { args: promptArgs })
  if (!command) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Agent ${agent.id} has no command`,
    })
  }

  const client = await ctx.getDaemonClient()
  // Wire exit-draining before spawning so the session is deregistered the
  // instant it exits (attach is idempotent per client).
  ctx.liveAgents.attach(client)
  const session = await client.spawn({
    command,
    args,
    cwd: dir,
    env: agent.env,
    cols: input.cols ?? 80,
    rows: input.rows ?? 24,
  })

  ctx.liveAgents.register(project.id, session.id)

  // Mark the workspace active so "recent" ordering reflects the launch.
  ctx.db
    .update(workspaces)
    .set({ lastActiveAt: Date.now() })
    .where(eq(workspaces.id, workspace.id))
    .run()

  return { sessionId: session.id, workspaceId: workspace.id, kind }
}

export const sessionsRouter = router({
  /**
   * Start an external CLI agent for a project under the worktree policy (docs/architecture.md, agent runtime).
   * Thin wrapper over {@link startAgentSession} — the shared start flow also used
   * by the automations dispatcher so the policy lives in one place.
   */
  start: publicProcedure
    .input(startInput)
    .mutation(({ ctx, input }): Promise<StartSessionResult> => startAgentSession(ctx, input)),
})
