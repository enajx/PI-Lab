import { type Automation, type AutomationRun, automationRuns } from "@skipper/local-db"
import { eq } from "drizzle-orm"
import type { AppContext } from "../trpc/context"
import { startAgentSession } from "../trpc/sessions/sessions"

/**
 * Fire one automation once (AGENTS.md "Scope" — Automations). Launch-only semantics
 * for v1: we record the run as `launched` (with the spun-up workspace id) the
 * moment the agent starts, or `failed` with the error — we do *not* track the
 * agent's eventual outcome. This is the single "what happens on fire" step the
 * scheduler and `runNow` both call, so a scheduled fire and a manual fire are
 * identical except for who computes `scheduledFor`.
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

  try {
    const result = await startAgentSession(ctx, {
      projectId: automation.projectId,
      agentId: automation.agentId,
      prompt: automation.prompt,
      name: automation.name,
    })
    const updated = ctx.db
      .update(automationRuns)
      .set({ state: "launched", workspaceId: result.workspaceId, launchedAt: Date.now() })
      .where(eq(automationRuns.id, run.id))
      .returning()
      .get()
    return updated ?? run
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to launch session"
    const updated = ctx.db
      .update(automationRuns)
      .set({ state: "failed", error: message })
      .where(eq(automationRuns.id, run.id))
      .returning()
      .get()
    return updated ?? run
  }
}

/** The signature the scheduler injects to fire a due automation. */
export type FireAutomation = (args: {
  automation: Automation
  scheduledFor: number
}) => Promise<unknown>
