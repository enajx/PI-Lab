import { realpath } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"
import {
  type AgentSessionOrigin,
  getAgentSettingsOrDefaults,
  getSettingsOrDefaults,
  type PiLabDatabase,
  type Project,
  projects,
  type Workspace,
  workspaces,
} from "@pi-lab/local-db"
import { buildLaunchArgv, DEFAULT_AGENT_ID, getAgent } from "@pi-lab/shared"
import { writeTextFile } from "@pi-lab/workspace-fs"
import { TRPCError } from "@trpc/server"
import { observable } from "@trpc/server/observable"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import type { LiveAgentStatus } from "../../../shared/agentStatus"
import type { ProjectAgentRow } from "../../../shared/projectAgents"
import { readProjectAgentConfig } from "../../agents/projectConfig"
import { isGitRepo } from "../../git"
import { withAgentLaunchGuard } from "../agentLaunchGuard"
import type { AppContext } from "../context"
import { publicProcedure, router } from "../trpc"
import { runningProjectWorkflowTasks } from "../workflows/running"
import { createWorkspace, workspaceWorkingDir } from "../workspaces"

/**
 * Sessions router — the "start agent session" flow.
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

/** The views an agent can be started from. */
const originSchema = z.enum(["project", "latex", "analysis"])

const startInput = z.object({
  projectId: z.string().min(1),
  agentId: z.string().min(1),
  /** The view the agent is started from; each view shows only its own agents. */
  origin: originSchema,
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
/** Agent sessions run only in branch or worktree workspaces, never in a paper workspace. */
export type SessionKind = Exclude<Workspace["kind"], "paper">

export interface StartSessionResult {
  sessionId: string
  workspaceId: string
  kind: SessionKind
  /**
   * Shown to the user after a start that worked with a limit, e.g. an agent
   * that cannot be given the paper folder; null when there is none.
   */
  warning: string | null
}

/**
 * Decide the workspace kind for a new agent session:
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

/**
 * Extra folders for an agent started from the LaTeX Editor: the linked paper
 * folder whenever the agent's working folder does not contain it (a paper
 * outside the project, or any paper when the agent runs in a worktree). Both
 * sides are compared as real paths. Other views get none.
 */
export async function paperExtraDirs(
  project: Project,
  origin: AgentSessionOrigin,
  workingDir: string,
): Promise<string[]> {
  const dir = project.metadata?.paper?.dir
  if (origin !== "latex" || !dir) return []
  const paperDir = await realpath(dir)
  const path = relative(await realpath(workingDir), paperDir)
  const inside = path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  return inside ? [] : [paperDir]
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
  /** The view the agent is started from, recorded with the session. */
  origin: AgentSessionOrigin
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
 * through the exact same policy path. It decides
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
  const agentSettings = getAgentSettingsOrDefaults(ctx.db)
  const [catalogCommand] = buildLaunchArgv(agent, {
    ...agentSettings.launchDefaults[agent.id],
    args: promptArgs,
  })
  const configuredCommand = agentSettings.executableOverrides[agent.id]?.trim()
  const candidate = configuredCommand || catalogCommand
  const command = candidate ? await ctx.resolveAgentExecutable(candidate) : null
  if (!command) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${agent.label} is not available at ${candidate || "(no executable configured)"}. Configure its executable path in Settings → Agents & worktrees.`,
    })
  }

  return withAgentLaunchGuard({
    projectId: project.id,
    gitAvailable,
    liveAgentCount: () => ctx.activityMonitor.liveAgentCount(project.id),
    launch: async () => {
      const appSettings = getSettingsOrDefaults(ctx.db)
      const { worktreePerAgent } = appSettings
      const kind =
        !gitAvailable || input.workspaceMode === "main"
          ? "branch"
          : input.workspaceMode === "worktree"
            ? "worktree"
            : decideSessionKind(worktreePerAgent, ctx.activityMonitor.liveAgentCount(project.id))

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

      // The paper folder can only be compared once the working folder is known.
      const extraDirs = await paperExtraDirs(project, input.origin, dir)
      const [, ...args] = buildLaunchArgv(agent, {
        ...agentSettings.launchDefaults[agent.id],
        extraDirs,
        args: promptArgs,
      })
      // An agent with no extra-folder flag still starts; the user is told what it cannot see.
      const warning =
        extraDirs.length > 0 && !agent.addDirArg
          ? `${agent.label} cannot be given the paper folder ${extraDirs.join(", ")}; it only sees the project folder.`
          : null

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
        origin: input.origin,
        turnArmed: Boolean(input.prompt?.trim()),
        cols: input.cols ?? 80,
        rows: input.rows ?? 24,
      })
      const session = spawned

      // Mark the workspace active so "recent" ordering reflects the launch.
      ctx.db
        .update(workspaces)
        .set({ lastActiveAt: Date.now() })
        .where(eq(workspaces.id, workspace.id))
        .run()

      return { sessionId: session.id, workspaceId: workspace.id, kind, warning }
    },
  })
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
  const config = await readProjectAgentConfig(project, storage)
  const agentId =
    config.agentId ?? getAgentSettingsOrDefaults(ctx.db).defaultAgentId ?? DEFAULT_AGENT_ID

  // Seed the placeholder BEFORE the agent launches, via the pre-spawn hook, so the
  // worktree always has AUTORESEARCH.md before the session starts and a failed seed
  // aborts the start rather than orphaning a live session.
  return startAgentSession(ctx, {
    projectId: project.id,
    agentId,
    name: `auto-research-${Date.now().toString(36)}`,
    workspaceMode: "worktree",
    origin: "project",
    onWorkspaceReady: async (dir) => {
      await writeTextFile(join(dir, AUTORESEARCH_FILENAME), AUTORESEARCH_PLACEHOLDER)
    },
  })
}

/**
 * The rows of a project's "Project Agents" box: its live agents started outside
 * the Project view (LaTeX Editor, Analysis) and its running background workflow
 * runs. An agent waiting after a finished turn reads "done"; any other wait reads
 * "waiting". Exited agents are not live and are left out.
 */
export function listProjectAgents(ctx: AppContext, projectId: string): ProjectAgentRow[] {
  const now = Date.now()
  const agents = ctx.activityMonitor.liveAgents(projectId).flatMap((session): ProjectAgentRow[] => {
    if (session.origin === "project" || session.state === "exited") return []
    return [
      {
        kind: "agent",
        sessionId: session.sessionId,
        agentId: session.agentId,
        origin: session.origin,
        name: getAgent(session.agentId, ctx.agentCatalog)?.label ?? session.agentId,
        status:
          session.state === "working"
            ? "working"
            : session.waitingReason === "turn-complete"
              ? "done"
              : "waiting",
        lastActiveAt:
          session.state === "working" ? now : (session.waitingSince ?? session.updatedAt),
      },
    ]
  })
  const background = runningProjectWorkflowTasks(projectId).map(
    (task): ProjectAgentRow => ({ kind: "background", task, status: "working", lastActiveAt: now }),
  )
  return [...agents, ...background]
}

export const sessionsRouter = router({
  /** The rows of a project's "Project Agents" box (see {@link listProjectAgents}). */
  projectAgents: publicProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .query(({ ctx, input }): ProjectAgentRow[] => listProjectAgents(ctx, input.projectId)),
  /** One compact stream shared by shell indicators and the title bar. */
  onStatus: publicProcedure.subscription(({ ctx }) =>
    observable<LiveAgentStatus[]>((emit) =>
      ctx.activityStatus.subscribe((sessions) => emit.next(sessions)),
    ),
  ),
  /**
   * Start an external CLI agent for a project under the worktree policy.
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
