import {
  type Automation,
  type AutomationRun,
  automationRuns,
  getAgentSettingsOrDefaults,
  projects,
} from "@pi-lab/local-db"
import { buildNonInteractiveLaunchArgv, getAgent } from "@pi-lab/shared"
import { eq } from "drizzle-orm"
import type { AppContext } from "../trpc/context"
import { startAgentSession } from "../trpc/sessions/sessions"
import type { NonInteractiveProcessResult } from "./nonInteractiveRunner"
import { createWorkflowLifecycleReporter } from "./workflowLifecycle"

/**
 * Fire one automation once (AGENTS.md "Scope" — Automations). Interactive runs
 * are targeted to a PTY agent session whose activity monitor owns the later
 * terminal transition. Non-interactive runs spawn a supported one-shot CLI and
 * follow its actual process lifecycle. This is the single "what happens on
 * fire" step the scheduler and `runNow` both call, so a scheduled fire and a
 * manual fire are identical except for who computes `scheduledFor`.
 *
 * Overlap / double-fire guard: a run row is inserted *up front* with
 * `state: "pending"`, conflicting on the unique `(automationId, scheduledFor)`
 * index. If another tick already inserted a row for this occurrence, the insert
 * is a no-op (`onConflictDoNothing` returns nothing) and we bail — the
 * occurrence has already been claimed. `runNow` uses a fresh `Date.now()`
 * `scheduledFor` so a manual run never collides with the regular cadence.
 *
 * Returns the run row (created or the one already covering this occurrence), or
 * `null` when the occurrence was already claimed by a concurrent fire.
 */
export async function dispatchAutomation(
  ctx: AppContext,
  args: { automation: Automation; scheduledFor: number },
): Promise<AutomationRun | null> {
  const { automation, scheduledFor } = args

  // Claim the occurrence: insert a pending run, no-op on conflict (overlap guard).
  const claimed = ctx.db
    .insert(automationRuns)
    .values({ automationId: automation.id, scheduledFor, state: "pending" })
    .onConflictDoNothing({
      target: [automationRuns.automationId, automationRuns.scheduledFor],
    })
    .returning()
    .all()

  const run = claimed[0]
  if (!run) return null // Already claimed by a concurrent fire.

  if (automation.executionMode === "noninteractive") {
    return dispatchNonInteractiveAutomation(ctx, automation, run)
  }

  try {
    const result = await startAgentSession(ctx, {
      projectId: automation.projectId,
      agentId: automation.agentId,
      prompt: automation.prompt,
      name: automation.name,
      workflowRunId: run.id,
    })
    const updated = ctx.db
      .update(automationRuns)
      .set({
        state: "running",
        workspaceId: result.workspaceId,
        sessionId: result.sessionId,
        launchedAt: Date.now(),
      })
      .where(eq(automationRuns.id, run.id))
      .returning()
      .get()
    return updated ?? run
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to launch session"
    const updated = ctx.db
      .update(automationRuns)
      .set({ state: "failed", error: message, completedAt: Date.now() })
      .where(eq(automationRuns.id, run.id))
      .returning()
      .get()
    const failed = updated ?? run
    ctx.notificationService.notify({
      eventType: "workflowFailure",
      title: "Workflow failed",
      body: message,
      target: { type: "workflow", workflowId: automation.id, runId: run.id },
    })
    return failed
  }
}

async function dispatchNonInteractiveAutomation(
  ctx: AppContext,
  automation: Automation,
  run: AutomationRun,
): Promise<AutomationRun> {
  const lifecycle = createWorkflowLifecycleReporter(
    { db: ctx.db, notifications: ctx.notificationService },
    {
      source: "noninteractive",
      workflowId: automation.id,
      runId: run.id,
      workflowName: automation.name,
    },
  )

  try {
    const project = ctx.db
      .select()
      .from(projects)
      .where(eq(projects.id, automation.projectId))
      .get()
    if (!project) throw new Error(`No project ${automation.projectId}`)

    const agent = getAgent(automation.agentId, ctx.agentCatalog)
    if (!agent) throw new Error(`No agent ${automation.agentId}`)

    const [catalogCommand, ...args] = buildNonInteractiveLaunchArgv(agent, automation.prompt)
    const configuredCommand = getAgentSettingsOrDefaults(ctx.db).executableOverrides[
      agent.id
    ]?.trim()
    const candidate = configuredCommand || catalogCommand
    const command = candidate ? await ctx.resolveAgentExecutable(candidate) : null
    if (!command) {
      throw new Error(
        `${agent.label} is not available at ${candidate || "(no executable configured)"}. Configure its executable path in Settings → Agents & worktrees.`,
      )
    }

    const launchEnvironment = await ctx.getAgentLaunchEnvironment()
    const started = await ctx.runNonInteractiveProcess({
      command,
      args,
      cwd: project.repoPath,
      env: { ...launchEnvironment, ...agent.env },
    })
    lifecycle.started()
    const endActivity = ctx.caffeine.beginMeaningfulActivity(`workflow:${run.id}`)
    void started.completion
      .then(
        (result) => {
          endActivity()
          if (result.code === 0 && result.signal === null && result.error === null) {
            lifecycle.completed()
            return
          }
          lifecycle.failed(nonInteractiveFailure(agent.label, result))
        },
        (error) => {
          endActivity()
          lifecycle.failed(
            error instanceof Error
              ? `${agent.label} process failed: ${error.message}`
              : `${agent.label} process failed`,
          )
        },
      )
      .catch((error) => {
        console.warn(
          `[pi-lab] failed to persist workflow ${run.id} process lifecycle: ${String(error)}`,
        )
      })
  } catch (error) {
    lifecycle.failed(error instanceof Error ? error.message : "Failed to run workflow")
  }

  return ctx.db.select().from(automationRuns).where(eq(automationRuns.id, run.id)).get() ?? run
}

function nonInteractiveFailure(agentLabel: string, result: NonInteractiveProcessResult): string {
  if (result.error) return `${agentLabel} process failed: ${result.error}`
  const exit =
    result.signal !== null
      ? `after signal ${result.signal}`
      : result.code !== null
        ? `with code ${result.code}`
        : "without an exit status"
  const detail = result.stderr.trim()
  return `${agentLabel} exited ${exit}${detail ? `: ${detail}` : ""}`
}

/** The signature the scheduler injects to fire a due automation. */
export type FireAutomation = (args: {
  automation: Automation
  scheduledFor: number
}) => Promise<unknown>
