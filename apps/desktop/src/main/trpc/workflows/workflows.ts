import { EventEmitter } from "node:events"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import {
  getAgentSettingsOrDefaults,
  type PiLabDatabase,
  type Project,
  type ProjectWorkflowRun,
  projects,
  projectWorkflowRuns,
  type WorkflowTask,
} from "@pi-lab/local-db"
import { buildNonInteractiveLaunchArgv, DEFAULT_AGENT_ID, getAgent } from "@pi-lab/shared"
import { statFile, writeTextFile } from "@pi-lab/workspace-fs"
import { TRPCError } from "@trpc/server"
import { observable } from "@trpc/server/observable"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { readProjectAgentConfig } from "../../agents/projectConfig"
import { nonInteractiveFailure } from "../../automations/dispatch"
import type {
  NonInteractiveProcessResult,
  StartedNonInteractiveProcess,
} from "../../automations/nonInteractiveRunner"
import { computeGitStateHash, isGitRepo } from "../../git"
import type { AppContext } from "../context"
import { resolveInsideDir } from "../files/files"
import { publicProcedure, router } from "../trpc"
import { ClaudeStreamParser } from "./claudeStreamParser"
import { planResearchPrompt } from "./planResearchSkill"

/**
 * Non-interactive background project workflows (plan "Project cards / panels /
 * settings"). Both "Project summary" and "Fetch remote experiments" run the
 * project's remembered agent **headlessly** (one-shot CLI, no PTY, no visible
 * session) in the project's main checkout, capture the printed summary, and cache
 * it per (project, task). A run only re-executes when the repository's git state
 * has changed since the cached result (a new commit or any working-tree change);
 * otherwise the cached result is returned unchanged. Failures and timeouts are
 * recorded as an error on the cached record — never a silent hang.
 *
 * Auto-research is deliberately NOT here: it stays an interactive worktree
 * session (see `../sessions/sessions`).
 */

/** Hard wall-clock cap for a single workflow run; a hang past this is a failure. */
const WORKFLOW_TIMEOUT_MS = 180_000

/**
 * In-memory "currently running" tracker, keyed by `${projectId}:${task}`. The DB
 * only ever stores the last COMPLETED result, so this is the sole source of the
 * transient running flag `status` reports. It lives for the process lifetime, so
 * on startup nothing is running — exactly the desired reset.
 */
const runningTasks = new Set<string>()
const runningKey = (projectId: string, task: WorkflowTask): string => `${projectId}:${task}`

/** Keep project records until background completion has been persisted. */
export function hasRunningProjectWorkflow(projectId: string): boolean {
  return ["summary", "fetch-experiments", "plan-research"].some((task) =>
    runningTasks.has(`${projectId}:${task}`),
  )
}

/**
 * One event in a run's live output stream, delivered to the renderer via the
 * {@link workflowsRouter.onOutput} subscription so the user can watch the agent
 * work in real time:
 *   - `start`  — the command/agent being run (shown at the top of the log).
 *   - `chunk`  — an incremental `stdout`/`stderr` fragment as it is printed.
 *   - `done`   — the run finished; carries the final (trimmed) printed result.
 *   - `error`  — the run failed / timed out; carries the user-facing message.
 * `done`/`error` are terminal: the subscription completes after emitting one.
 */
export type WorkflowOutputEvent =
  | { kind: "start"; command: string }
  | { kind: "chunk"; stream: "stdout" | "stderr"; text: string }
  | { kind: "done"; result: string }
  | { kind: "error"; message: string }

/**
 * The live output buffer + emitter for one run, keyed by `${projectId}:${task}`.
 * A new subscriber replays `command` + buffered `chunks` (+ any `terminal`
 * event) so it sees prior output, then receives subsequent chunks live. The
 * buffer is bounded so a chatty agent can't grow memory without limit; the
 * `command` and terminal event are pinned (never dropped). The last run's stream
 * is kept after completion so opening the popup on a done/error control still
 * shows that run's log — it is replaced only when a new run for the key starts.
 */
interface RunStream {
  process?: StartedNonInteractiveProcess
  command: string | null
  chunks: Extract<WorkflowOutputEvent, { kind: "chunk" }>[]
  bufferedChars: number
  terminal: Extract<WorkflowOutputEvent, { kind: "done" | "error" }> | null
  emitter: EventEmitter
}

/** Cap on retained live-log text per run; oldest chunks are dropped past this. */
const MAX_STREAM_CHARS = 256 * 1024

const activeRuns = new Map<string, RunStream>()

/**
 * Fires (event name = the run key) the moment a run's stream is created. A live
 * subscriber that connected BEFORE the run started — e.g. the dialog subscribes
 * on click while `runProjectWorkflow` is still `await`ing the git-state hash, so
 * the stream doesn't exist yet — waits on this instead of completing empty and
 * missing the entire run.
 */
const runStarted = new EventEmitter()
runStarted.setMaxListeners(0)

/** Start a fresh stream for a run, replacing any prior one for the same key. */
function createStream(key: string): RunStream {
  const emitter = new EventEmitter()
  // Any number of renderer windows/panes may watch a run; lift the listener cap.
  emitter.setMaxListeners(0)
  const stream: RunStream = {
    command: null,
    chunks: [],
    bufferedChars: 0,
    terminal: null,
    emitter,
  }
  activeRuns.set(key, stream)
  // Wake any subscriber that connected before this run started (see runStarted).
  runStarted.emit(key)
  return stream
}

/** Record (and broadcast) the command/agent line shown atop the live log. */
function startStream(stream: RunStream, command: string): void {
  stream.command = command
  stream.emitter.emit("event", { kind: "start", command } satisfies WorkflowOutputEvent)
}

/** Append a live output chunk, dropping the oldest chunks past the size cap. */
function pushChunk(stream: RunStream, stream_: "stdout" | "stderr", text: string): void {
  const event = { kind: "chunk", stream: stream_, text } as const
  stream.chunks.push(event)
  stream.bufferedChars += text.length
  while (stream.bufferedChars > MAX_STREAM_CHARS && stream.chunks.length > 1) {
    const dropped = stream.chunks.shift()
    if (dropped) stream.bufferedChars -= dropped.text.length
  }
  stream.emitter.emit("event", event)
}

/** Mark a stream terminal (done/error) and broadcast the final event. */
function finishStream(
  stream: RunStream,
  terminal: Extract<WorkflowOutputEvent, { kind: "done" | "error" }>,
): void {
  stream.terminal = terminal
  stream.emitter.emit("event", terminal)
}

/**
 * Prompt for the headless "Project summary" run. Instructs the remembered agent
 * (running in the project's repo cwd, non-interactively) to review the project's
 * current status, update the `## Status` section of `RESEARCH.md` in place via its
 * own file tools, and print a short user-facing summary as its final output — that
 * printed text is captured from stdout and shown to the user in the result popup.
 */
const PROJECT_SUMMARY_PROMPT = `Summarise this project's current status.

1. Review the recent git commits, the project's TODOs, and any experiment results present in the repository.
2. Update RESEARCH.md in the repository root: create or replace a "## Status" section with a concise, up-to-date summary of where the project stands (what is done, what is in progress, and what is next). Make this edit directly using your file-editing tools.
3. Finally, print a short (a few sentences) plain-text summary of the project's current status as your last output. This printed text is shown to the user in a popup, so keep it self-contained and free of tool chatter.`

/**
 * Fixed skill PI Lab scaffolds for "Fetch remote experiments". The name is a
 * constant — never user-supplied — so it can't be steered to escape the project's
 * `.claude/skills` directory (the write is still path-jailed below).
 */
const FETCH_EXPERIMENTS_SKILL_NAME = "fetch-experiments"
const FETCH_EXPERIMENTS_SKILL_RELPATH = join(
  ".claude",
  "skills",
  FETCH_EXPERIMENTS_SKILL_NAME,
  "SKILL.md",
)

/**
 * Placeholder `SKILL.md` scaffolded on first use. Real cluster wiring is out of
 * scope: this is an example the user later edits for their own cluster. PI Lab
 * never overwrites it once it exists, so those edits are safe.
 */
const FETCH_EXPERIMENTS_SKILL_PLACEHOLDER = `---
name: ${FETCH_EXPERIMENTS_SKILL_NAME}
description: Fetch experiment results from a cluster run into this project.
---

# Fetch remote experiments (placeholder)

This is a **scaffolded placeholder** skill. Edit it to wire up your own cluster:
describe how to connect, which run's results to pull, and where to place the
fetched artifacts in this project.

PI Lab created this file on first use of "Fetch remote experiments" and will
never overwrite it — your edits are safe.

## Steps (example — replace with your cluster's real commands)

1. Connect to the cluster (e.g. \`ssh <host>\` or your scheduler's CLI).
2. Locate the run's output directory for this project.
3. Copy the results back into the project (e.g. \`rsync\` into \`results/\`).
4. Summarize what was fetched.
`

/**
 * Prompt for the headless "Fetch remote experiments" run: run the scaffolded
 * skill, then print a concise summary of what was fetched (captured from stdout).
 */
const FETCH_EXPERIMENTS_PROMPT = `Use the ${FETCH_EXPERIMENTS_SKILL_NAME} skill to fetch this project's experiment results from its cluster run.

When finished, print a short (a few sentences) plain-text summary of what was fetched as your last output. This printed text is shown to the user in a popup, so keep it self-contained and free of tool chatter.`

/**
 * Scaffold the fetch-experiments `SKILL.md` into the project's repo if missing.
 * Idempotent: an existing SKILL.md is never overwritten. The write is jailed to
 * the project repo via {@link resolveInsideDir} even though the relative path is a
 * fixed constant.
 */
async function scaffoldFetchExperimentsSkill(repoPath: string): Promise<void> {
  const repo = await realpath(repoPath)
  const target = resolveInsideDir(repo, FETCH_EXPERIMENTS_SKILL_RELPATH)
  const existing = await statFile(target)
  if (existing.exists) return
  await writeTextFile(target, FETCH_EXPERIMENTS_SKILL_PLACEHOLDER)
}

/** The base prompt for a task, with any extra fetch instructions appended. */
function promptForTask(task: WorkflowTask, instructions: string | undefined): string {
  if (task === "summary") return PROJECT_SUMMARY_PROMPT
  const extra = instructions?.trim()
  return extra ? `${FETCH_EXPERIMENTS_PROMPT}\n\n${extra}` : FETCH_EXPERIMENTS_PROMPT
}

/** The renderer-facing view of one task's cached state (plus the live running flag). */
export interface ProjectWorkflowRecord {
  /** True while a run for this (project, task) is in flight (in-memory only). */
  running: boolean
  /** Last captured summary text ("" when the run printed none, or none yet). */
  result: string
  /** Git-state hash the cached result was computed against. */
  inputHash: string
  /** When the result was last (re-)computed or re-checked (epoch ms); 0 if never. */
  lastCheckedAt: number
  /** Failure detail from the last run, or null on success / never-run. */
  errorMessage: string | null
}

/** Result of {@link runProjectWorkflow}: the record plus whether it was cached. */
export interface RunProjectWorkflowResult extends ProjectWorkflowRecord {
  /** True when the git state was unchanged and the stored result was reused. */
  cached: boolean
}

export interface RunProjectWorkflowInput {
  projectId: string
  task: WorkflowTask
  /** Re-run even when the git state is unchanged (bypass the cache). */
  force?: boolean
  /** Extra instructions appended to the fetch-experiments prompt (from Settings). */
  instructions?: string
}

/** Read the stored row for one (project, task), if any. */
function readRow(
  db: PiLabDatabase,
  projectId: string,
  task: WorkflowTask,
): ProjectWorkflowRun | null {
  return (
    db
      .select()
      .from(projectWorkflowRuns)
      .where(and(eq(projectWorkflowRuns.projectId, projectId), eq(projectWorkflowRuns.task, task)))
      .get() ?? null
  )
}

/** Upsert the last-completed record for one (project, task) via the unique index. */
function upsertRow(
  db: PiLabDatabase,
  projectId: string,
  task: WorkflowTask,
  values: { result: string; inputHash: string; lastCheckedAt: number; errorMessage: string | null },
): ProjectWorkflowRun {
  const now = Date.now()
  return db
    .insert(projectWorkflowRuns)
    .values({ projectId, task, ...values, updatedAt: now })
    .onConflictDoUpdate({
      target: [projectWorkflowRuns.projectId, projectWorkflowRuns.task],
      set: { ...values, updatedAt: now },
    })
    .returning()
    .get()
}

/** Project the persisted row into the renderer-facing record, with a running flag. */
function toRecord(row: ProjectWorkflowRun, running: boolean): ProjectWorkflowRecord {
  return {
    running,
    result: row.result,
    inputHash: row.inputHash,
    lastCheckedAt: row.lastCheckedAt,
    errorMessage: row.errorMessage,
  }
}

/**
 * Execute the headless run for a task and return its captured summary text, or
 * throw an `Error` whose message is the user-facing failure. Every failure mode
 * (agent missing / unsupported / unavailable, process error, non-zero exit,
 * timeout) surfaces as a throw so the caller records it as an error record.
 */
async function executeWorkflow(
  ctx: AppContext,
  project: Project,
  input: RunProjectWorkflowInput,
  stream: RunStream,
  inputHash: string,
): Promise<string> {
  if (input.task === "fetch-experiments") await scaffoldFetchExperimentsSkill(project.repoPath)

  const prompt =
    input.task === "plan-research"
      ? await planResearchPrompt(project.repoPath, ctx.skillsHomeDir, ctx.bundledSkillsDir)
      : promptForTask(input.task, input.instructions)

  // The project's remembered agent choice, falling back to the catalog default.
  const storage = getAgentSettingsOrDefaults(ctx.db).projectConfigStorage
  const config = await readProjectAgentConfig(project, storage)
  const agentId =
    config.agentId ?? getAgentSettingsOrDefaults(ctx.db).defaultAgentId ?? DEFAULT_AGENT_ID
  const agent = getAgent(agentId, ctx.agentCatalog)
  if (!agent) throw new Error(`No agent ${agentId}`)

  // buildNonInteractiveLaunchArgv throws for an agent that can't run headless —
  // that surfaces as an error record, not a silent no-op.
  const [catalogCommand, ...baseArgs] = buildNonInteractiveLaunchArgv(
    agent,
    prompt,
    getAgentSettingsOrDefaults(ctx.db).launchDefaults[agent.id],
  )
  const configuredCommand = getAgentSettingsOrDefaults(ctx.db).executableOverrides[agent.id]?.trim()
  const candidate = configuredCommand || catalogCommand
  const command = candidate ? await ctx.resolveAgentExecutable(candidate) : null
  if (!command) {
    throw new Error(
      `${agent.label} is not available at ${candidate || "(no executable configured)"}. Configure its executable path in Settings → Agents & worktrees.`,
    )
  }

  // Claude runs in streaming-JSON mode so we can show its live steps: it emits one
  // JSON object per line (both flags are required together). Other agents (Codex)
  // keep printing plain text and we stream that raw. The parser turns Claude's JSON
  // lines into concise activity lines and captures the final report separately.
  const isClaude = agent.id === "claude-code"
  const args = isClaude ? [...baseArgs, "--output-format", "stream-json", "--verbose"] : baseArgs
  const parser = isClaude ? new ClaudeStreamParser() : null

  // Announce the HONEST invocation atop the live log — the executable plus its
  // real flags (so the non-interactive mode is visible), with the multi-paragraph
  // prompt collapsed to one clipped line so it stays readable.
  const shownArgs = args
    .map((arg) => {
      const flat = arg.replace(/\s+/g, " ")
      const clipped = flat.length > 60 ? `${flat.slice(0, 60)}…` : flat
      return /\s/.test(arg) ? `"${clipped}"` : clipped
    })
    .join(" ")
  startStream(stream, `${command} ${shownArgs}`)

  const launchEnvironment = await ctx.getAgentLaunchEnvironment()
  const started = await ctx.runNonInteractiveProcess({
    metadata: {
      kind: "project-workflow",
      projectId: project.id,
      task: input.task,
      inputHash,
      agentLabel: agent.label,
      agentId: agent.id,
    },
    command,
    args,
    cwd: project.repoPath,
    env: { ...launchEnvironment, ...agent.env },
    timeoutMs: WORKFLOW_TIMEOUT_MS,
    onOutput: (chunk, streamName) => {
      // Claude stdout is JSON lines → parse into readable steps; its stderr and
      // every Codex stream pass through as raw activity text.
      if (parser && streamName === "stdout") {
        for (const line of parser.ingest(chunk)) pushChunk(stream, "stdout", `${line}\n`)
        return
      }
      pushChunk(stream, streamName, chunk)
    },
  })
  stream.process = started
  const result = await started.completion
  return workflowResult(agent.label, isClaude, result, parser)
}

/** Decode the retained final output as well as live chunks, including after reconnect. */
function workflowResult(
  agentLabel: string,
  isClaude: boolean,
  result: NonInteractiveProcessResult,
  liveParser: ClaudeStreamParser | null,
): string {
  const failed =
    result.error !== null || result.signal !== null || (result.code !== null && result.code !== 0)
  if (failed) throw new Error(nonInteractiveFailure(agentLabel, result))
  if (isClaude) {
    liveParser?.flush()
    const parser = liveParser?.result !== null && liveParser ? liveParser : new ClaudeStreamParser()
    if (parser !== liveParser) parser.ingest(result.stdout)
    // Drain a trailing line lacking a newline, then take the report from the
    // parsed `result` event (NOT the raw JSON stdout). An `is_error` result
    // surfaces as a failure rather than a silently-stored bad summary.
    parser.flush()
    if (parser.isError) throw new Error(parser.result || `${agentLabel} reported an error`)
    return (parser.result ?? "").trim()
  }
  return result.stdout.trim()
}

/**
 * Execute the headless run to completion in the background: stream its output to
 * the run's live buffer/emitter, persist the captured summary (success) or the
 * failure message (error/timeout), emit the terminal stream event, and clear the
 * running flag. Never throws — every failure is surfaced as an error record and
 * an `error` terminal event, so a run can never hang or vanish silently.
 */
async function executeAndPersist(
  ctx: AppContext,
  project: Project,
  input: RunProjectWorkflowInput,
  currentHash: string,
  key: string,
  stream: RunStream,
): Promise<void> {
  return persistWorkflow(
    ctx,
    project.id,
    input.task,
    currentHash,
    key,
    stream,
    executeWorkflow(ctx, project, input, stream, currentHash),
  )
}

/** Share completion persistence between original runs and recovered daemon jobs. */
async function persistWorkflow(
  ctx: AppContext,
  projectId: string,
  task: WorkflowTask,
  currentHash: string,
  key: string,
  stream: RunStream,
  completion: Promise<string>,
): Promise<void> {
  try {
    const result = await completion
    if (
      !ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get()
    ) {
      throw new Error("The project was removed before its background work finished")
    }
    upsertRow(ctx.db, projectId, task, {
      result,
      inputHash: currentHash,
      lastCheckedAt: Date.now(),
      errorMessage: null,
    })
    finishStream(stream, { kind: "done", result })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Routine failed"
    // Older app versions could remove a project while its daemon job was running.
    // Finish and acknowledge that owner without recreating the removed project.
    if (ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get()) {
      upsertRow(ctx.db, projectId, task, {
        result: "",
        inputHash: currentHash,
        lastCheckedAt: Date.now(),
        errorMessage: message,
      })
    }
    finishStream(stream, { kind: "error", message })
  } finally {
    runningTasks.delete(key)
  }
  await stream.process?.acknowledge?.()
}

/** Restore run status and completion from a daemon-owned background workflow. */
export function restoreProjectWorkflow(
  ctx: AppContext,
  rawMetadata: Record<string, string>,
  process: StartedNonInteractiveProcess,
): Promise<void> {
  const metadata = z
    .object({
      projectId: z.string(),
      task: z.enum(["summary", "fetch-experiments", "plan-research"]),
      inputHash: z.string(),
      agentLabel: z.string(),
      agentId: z.string(),
    })
    .parse(rawMetadata)
  const task = metadata.task
  const key = runningKey(metadata.projectId, task)
  runningTasks.add(key)
  const stream = createStream(key)
  stream.process = process
  startStream(stream, "Restored background agent")
  return persistWorkflow(
    ctx,
    metadata.projectId,
    task,
    metadata.inputHash,
    key,
    stream,
    process.completion.then((result) =>
      workflowResult(metadata.agentLabel, metadata.agentId === "claude-code", result, null),
    ),
  )
}

/**
 * Start (or serve the cache for) a background project workflow, returning
 * **immediately** — the mutation never blocks on the headless agent.
 *
 * Flow: resolve the project, compute the current git-state hash, and — unless
 * `force` — return the stored result verbatim when it was computed against the
 * same hash and did not error. Otherwise mark the task running, kick off the
 * headless agent asynchronously (streaming into a fresh live buffer/emitter that
 * the {@link workflowsRouter.onOutput} subscription serves), and return the
 * running record right away. The background task persists the result and emits
 * the terminal event when it finishes. A run already in flight for this
 * (project, task) is never double-started — the running record is returned.
 */
export async function runProjectWorkflow(
  ctx: AppContext,
  input: RunProjectWorkflowInput,
): Promise<RunProjectWorkflowResult> {
  const project = ctx.db.select().from(projects).where(eq(projects.id, input.projectId)).get()
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.projectId}` })
  }
  const needsGit = input.task !== "plan-research"
  if (needsGit && !(await isGitRepo(project.repoPath))) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Project routines require Git. Initialize Git for this project first.",
    })
  }

  const currentHash = needsGit ? await computeGitStateHash(project.repoPath) : ""
  if (!ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.id, project.id)).get()) {
    throw new TRPCError({ code: "NOT_FOUND", message: `No project ${project.id}` })
  }
  const stored = readRow(ctx.db, project.id, input.task)
  if (
    needsGit &&
    !input.force &&
    stored &&
    !stored.errorMessage &&
    stored.inputHash === currentHash
  ) {
    return { cached: true, ...toRecord(stored, false) }
  }

  const key = runningKey(project.id, input.task)
  const runningRecord: RunProjectWorkflowResult = {
    cached: false,
    running: true,
    result: stored?.result ?? "",
    inputHash: currentHash,
    lastCheckedAt: stored?.lastCheckedAt ?? 0,
    errorMessage: null,
  }
  // Idempotent: a click on an already-running control returns the running record
  // without starting a second process (or clobbering the live stream).
  if (runningTasks.has(key)) return runningRecord

  runningTasks.add(key)
  const stream = createStream(key)
  void executeAndPersist(ctx, project, input, currentHash, key, stream)
  return runningRecord
}

/** Both tasks' current state for a project (null when never run and not running). */
export interface ProjectWorkflowStatus {
  planResearch: ProjectWorkflowRecord | null
  summary: ProjectWorkflowRecord | null
  fetchExperiments: ProjectWorkflowRecord | null
}

function readStatus(
  ctx: AppContext,
  projectId: string,
  task: WorkflowTask,
): ProjectWorkflowRecord | null {
  const running = runningTasks.has(runningKey(projectId, task))
  const row = readRow(ctx.db, projectId, task)
  if (!row)
    return running
      ? { running, result: "", inputHash: "", lastCheckedAt: 0, errorMessage: null }
      : null
  return toRecord(row, running)
}

/** Current status of both background workflows for a project. */
export function projectWorkflowStatus(ctx: AppContext, projectId: string): ProjectWorkflowStatus {
  return {
    planResearch: readStatus(ctx, projectId, "plan-research"),
    summary: readStatus(ctx, projectId, "summary"),
    fetchExperiments: readStatus(ctx, projectId, "fetch-experiments"),
  }
}

const taskSchema = z.enum(["summary", "fetch-experiments", "plan-research"])

export const workflowsRouter = router({
  /**
   * Run (or serve the cache for) a background project workflow. Returns the
   * resulting record, including whether the git-state cache was served.
   */
  run: publicProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        task: taskSchema,
        force: z.boolean().optional(),
        instructions: z.string().optional(),
      }),
    )
    .mutation(
      ({ ctx, input }): Promise<RunProjectWorkflowResult> => runProjectWorkflow(ctx, input),
    ),

  /** Both tasks' current state (result / last-checked / error / running) for a project. */
  status: publicProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .query(({ ctx, input }): ProjectWorkflowStatus => projectWorkflowStatus(ctx, input.projectId)),

  /**
   * Live output of a (project, task)'s current/last run. MUST be an `observable`,
   * never an async generator — the `trpc-electron` IPC link throws on generators
   * — mirroring `terminal.onData`.
   *
   * On subscribe it replays the run's buffered output (the `start` command line
   * + accumulated `chunk`s) so a late subscriber sees prior output, then streams
   * every subsequent chunk, ending with the terminal `done`/`error` event after
   * which it completes. With no run ever started for the key it completes empty.
   */
  onOutput: publicProcedure
    .input(z.object({ projectId: z.string().min(1), task: taskSchema }))
    .subscription(({ input }) =>
      observable<WorkflowOutputEvent>((emit) => {
        const key = runningKey(input.projectId, input.task)
        let attachedStream: RunStream | null = null
        let streamListener: ((event: WorkflowOutputEvent) => void) | null = null

        // Attach to a live stream: replay its buffered output, then stream every
        // subsequent event (replay + listener attach run synchronously, so no
        // live event can interleave and be missed).
        const attach = (stream: RunStream) => {
          attachedStream = stream
          if (stream.command !== null) emit.next({ kind: "start", command: stream.command })
          for (const chunk of stream.chunks) emit.next(chunk)
          if (stream.terminal) {
            emit.next(stream.terminal)
            emit.complete()
            return
          }
          const listener = (event: WorkflowOutputEvent) => {
            emit.next(event)
            if (event.kind === "done" || event.kind === "error") emit.complete()
          }
          streamListener = listener
          stream.emitter.on("event", listener)
        }

        const existing = activeRuns.get(key)
        // If the run hasn't created its stream yet (the subscribe raced the
        // mutation's git-hash await), wait for it to start rather than completing
        // empty — otherwise the whole run is missed and the log stays blank.
        const onStart = existing
          ? null
          : () => {
              const stream = activeRuns.get(key)
              if (stream) attach(stream)
            }
        if (existing) attach(existing)
        else if (onStart) runStarted.once(key, onStart)

        return () => {
          if (onStart) runStarted.off(key, onStart)
          if (attachedStream && streamListener) attachedStream.emitter.off("event", streamListener)
        }
      }),
    ),
})
