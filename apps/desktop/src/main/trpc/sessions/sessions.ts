import { join } from "node:path"
import {
  agentSessions,
  getAgentSettingsOrDefaults,
  getSettingsOrDefaults,
  type PiLabDatabase,
  projects,
  type Workspace,
  workspaces,
} from "@pi-lab/local-db"
import { buildLaunchArgv, DEFAULT_AGENT_ID, getAgent } from "@pi-lab/shared"
import { writeTextFile } from "@pi-lab/workspace-fs"
import { TRPCError } from "@trpc/server"
import { and, eq, ne } from "drizzle-orm"
import { z } from "zod"
import { readProjectAgentConfig } from "../../agents/projectConfig"
import { isGitRepo } from "../../git"
import { withAgentLaunchGuard } from "../agentLaunchGuard"
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
  /**
   * Pre-spawn hook invoked right after the working dir is resolved and **before**
   * the agent PTY is spawned, so callers can seed files into the workspace (e.g.
   * `AUTORESEARCH.md`) with a guaranteed seed-before-launch ordering. If it throws,
   * the session is never spawned, so a failed seed can't orphan a live agent.
   */
  onWorkspaceReady?: (workingDir: string, workspace: Workspace) => Promise<void>
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
  const gitAvailable = await isGitRepo(project.repoPath)
  const liveCount = ctx.activityMonitor.liveAgentCount(project.id)
  if (!gitAvailable && input.workspaceMode === "worktree") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Worktree agents require Git. Initialize Git for this project first.",
    })
  }
  if (!gitAvailable && liveCount > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "A non-Git project can run only one agent at a time. Close the live agent or Initialize Git.",
    })
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
  const kind =
    !gitAvailable || input.workspaceMode === "main"
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

  // Seed the workspace before the agent launches (seed-before-launch). A throw
  // here aborts the start before any PTY is spawned, so it can't orphan a session.
  if (input.onWorkspaceReady) await input.onWorkspaceReady(dir, workspace)

  const session = await withAgentLaunchGuard({
    projectId: project.id,
    gitAvailable,
    liveAgentCount: () => ctx.activityMonitor.liveAgentCount(project.id),
    launch: async () => {
      const client = await ctx.getDaemonClient()
      const launchEnvironment = await ctx.getAgentLaunchEnvironment()
      const spawned = await client.spawn({
        command,
        args,
        cwd: dir,
        env: { ...launchEnvironment, ...agent.env },
        cols: input.cols ?? 80,
        rows: input.rows ?? 24,
      })

      await ctx.activityMonitor.track({
        sessionId: spawned.id,
        projectId: project.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        workflowRunId: input.workflowRunId ?? null,
        turnArmed: Boolean(input.prompt?.trim()),
        cols: input.cols ?? 80,
        rows: input.rows ?? 24,
      })
      return spawned
    },
  })

  // Mark the workspace active so "recent" ordering reflects the launch.
  ctx.db
    .update(workspaces)
    .set({ lastActiveAt: Date.now() })
    .where(eq(workspaces.id, workspace.id))
    .run()

  return { sessionId: session.id, workspaceId: workspace.id, kind }
}

/** Filename PI Lab seeds into an auto-research worktree (placeholder for now). */
const AUTORESEARCH_FILENAME = "AUTORESEARCH.md"

/**
 * Placeholder `AUTORESEARCH.md` seeded into the isolated worktree. The real
 * auto-research loop is not implemented yet — launching auto-research currently
 * just opens an agent session in this worktree — and the real instructions will
 * live in this file later.
 */
const AUTORESEARCH_PLACEHOLDER = `# Auto-research (placeholder)

This file is a placeholder for PI Lab's auto-research instructions.

The real auto-research loop is **not implemented yet**. For now, launching
auto-research from a project card only:

- creates this isolated git worktree, separate from the project's main checkout, and
- opens an agent session in it.

The real auto-research instructions and loop will live in this file later.
`

/** Result of {@link startAutoResearch} — the seeded worktree's live session. */
export type StartAutoResearchResult = StartSessionResult

/**
 * Placeholder "Auto-research" trigger for a Dashboard project card. Opens an
 * isolated git-worktree agent session for the project — separate from its main
 * checkout — using the project's remembered agent (or the catalog default), then
 * seeds a placeholder {@link AUTORESEARCH_FILENAME} into that worktree. The real
 * auto-research loop is out of scope; this only opens the worktree agent session.
 *
 * Reuses the shared {@link startAgentSession} launch policy (worktree mode) so
 * worktree creation, agent resolution, and activity bookkeeping stay in one
 * place; the placeholder is written into the returned workspace's working dir
 * afterwards.
 */
export async function startAutoResearch(
  ctx: AppContext,
  input: { projectId: string },
): Promise<StartAutoResearchResult> {
  const project = ctx.db.select().from(projects).where(eq(projects.id, input.projectId)).get()
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.projectId}` })
  }

  // The project's remembered agent choice, falling back to the catalog default.
  const storage = getAgentSettingsOrDefaults(ctx.db).projectConfigStorage
  const config = await readProjectAgentConfig(ctx.db, project, storage)
  const agentId = config.agentId ?? DEFAULT_AGENT_ID

  // Seed the placeholder BEFORE the agent launches, via the pre-spawn hook, so the
  // worktree always has AUTORESEARCH.md before the session starts and a failed seed
  // aborts the start rather than orphaning a live session.
  return startAgentSession(ctx, {
    projectId: project.id,
    agentId,
    name: `auto-research-${Date.now().toString(36)}`,
    workspaceMode: "worktree",
    onWorkspaceReady: async (dir) => {
      await writeTextFile(join(dir, AUTORESEARCH_FILENAME), AUTORESEARCH_PLACEHOLDER)
    },
  })
}

export const sessionsRouter = router({
  /** Live sessions with enough context for the title bar status panel. */
  status: publicProcedure.query(({ ctx }) =>
    ctx.db
      .select({
        sessionId: agentSessions.sessionId,
        projectId: agentSessions.projectId,
        projectName: projects.name,
        agentId: agentSessions.agentId,
        state: agentSessions.state,
      })
      .from(agentSessions)
      .innerJoin(projects, eq(agentSessions.projectId, projects.id))
      .where(ne(agentSessions.state, "exited"))
      .all(),
  ),
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

  /**
   * Placeholder "Auto-research" trigger for a Dashboard project card. Opens an
   * isolated git-worktree agent session for the project and seeds a placeholder
   * `AUTORESEARCH.md` into it — the real auto-research loop is out of scope. Thin
   * wrapper over {@link startAutoResearch}.
   */
  startAutoResearch: publicProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .mutation(({ ctx, input }): Promise<StartAutoResearchResult> => startAutoResearch(ctx, input)),
})
