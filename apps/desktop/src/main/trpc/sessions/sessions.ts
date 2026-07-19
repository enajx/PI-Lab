import {
  agentSessions,
  getAgentSettingsOrDefaults,
  getSettingsOrDefaults,
  type PiLabDatabase,
  projects,
  type Workspace,
  workspaces,
} from "@pi-lab/local-db"
import { buildLaunchArgv, getAgent } from "@pi-lab/shared"
import { TRPCError } from "@trpc/server"
import { and, eq, ne } from "drizzle-orm"
import { z } from "zod"
import type { AppContext } from "../context"
import { publicProcedure, router } from "../trpc"
import { createWorkspace, workspaceWorkingDir } from "../workspaces"

/**
 * Sessions router — the "start agent session" flow (md/engineering/architecture.md (agent runtime), P5b).
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
  /** Optional initial prompt passed to the selected agent. */
  prompt: z.string().optional(),
  /**
   * Task launches use the main checkout because its TODO Markdown is their
   * source of truth. Other launches retain the normal concurrency policy.
   */
  workspaceMode: z.enum(["policy", "main", "worktree"]).default("policy"),
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
 * Decide the workspace kind for a new agent session, per md/engineering/architecture.md (agent runtime):
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
  db: PiLabDatabase,
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
  /** Override the normal worktree policy for a source-file-bound launch. */
  workspaceMode?: "policy" | "main" | "worktree"
  cols?: number
  rows?: number
  /** Workflow run whose initially-launched interactive turn this session owns. */
  workflowRunId?: string
}

/**
 * The "start agent session" flow as a plain function over {@link AppContext}, so
 * both the `sessions.start` mutation *and* the automations dispatcher fire agents
 * through the exact same policy path (md/engineering/architecture.md, agent runtime; no duplicated launch logic). It decides
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

  const promptArgs = input.prompt?.trim() ? [input.prompt] : []
  const [catalogCommand, ...args] = buildLaunchArgv(agent, { args: promptArgs })
  const configuredCommand = getAgentSettingsOrDefaults(ctx.db).executableOverrides[agent.id]?.trim()
  const candidate = configuredCommand || catalogCommand
  const command = candidate ? await ctx.resolveAgentExecutable(candidate) : null
  if (!command) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${agent.label} is not available at ${candidate || "(no executable configured)"}. Configure its executable path in Settings → Agents & worktrees.`,
    })
  }

  const appSettings = getSettingsOrDefaults(ctx.db)
  const { worktreePerAgent } = appSettings
  const liveCount = ctx.activityMonitor.liveAgentCount(project.id)
  const kind =
    input.workspaceMode === "main"
      ? "branch"
      : input.workspaceMode === "worktree"
        ? "worktree"
        : decideSessionKind(worktreePerAgent, liveCount)

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

  const client = await ctx.getDaemonClient()
  const launchEnvironment = await ctx.getAgentLaunchEnvironment()
  const session = await client.spawn({
    command,
    args,
    cwd: dir,
    env: { ...launchEnvironment, ...agent.env },
    cols: input.cols ?? 80,
    rows: input.rows ?? 24,
  })

  await ctx.activityMonitor.track({
    sessionId: session.id,
    projectId: project.id,
    workspaceId: workspace.id,
    agentId: agent.id,
    workflowRunId: input.workflowRunId ?? null,
    turnArmed: Boolean(input.prompt?.trim()),
    cols: input.cols ?? 80,
    rows: input.rows ?? 24,
  })

  // Mark the workspace active so "recent" ordering reflects the launch.
  ctx.db
    .update(workspaces)
    .set({ lastActiveAt: Date.now() })
    .where(eq(workspaces.id, workspace.id))
    .run()

  return { sessionId: session.id, workspaceId: workspace.id, kind }
}

export const sessionsRouter = router({
  /** Live agent state, grouped by project in the renderer for project-level indicators. */
  activity: publicProcedure.query(({ ctx }) =>
    ctx.db
      .select({ projectId: agentSessions.projectId, state: agentSessions.state })
      .from(agentSessions)
      .where(ne(agentSessions.state, "exited"))
      .all(),
  ),
  /**
   * Start an external CLI agent for a project under the worktree policy (md/engineering/architecture.md, agent runtime).
   * Thin wrapper over {@link startAgentSession} — the shared start flow also used
   * by the automations dispatcher so the policy lives in one place.
   */
  start: publicProcedure
    .input(startInput)
    .mutation(({ ctx, input }): Promise<StartSessionResult> => startAgentSession(ctx, input)),
})
