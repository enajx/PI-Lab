import {
  type Automation,
  type AutomationPromptVersion,
  type AutomationRun,
  automationPromptVersions,
  automationRuns,
  automations,
  projects,
  type SkipperDatabase,
} from "@skipper/local-db"
import {
  describeSchedule,
  isValidRrule,
  nextOccurrence,
  upcomingOccurrences,
} from "@skipper/shared"
import { TRPCError } from "@trpc/server"
import { desc, eq } from "drizzle-orm"
import { z } from "zod"
import { dispatchAutomation } from "../../automations/dispatch"
import { publicProcedure, router } from "../trpc"

/**
 * Automations router (AGENTS.md §1 — Automations / Workflows): CRUD over the
 * `automations` table plus the prompt-version history, the run log, and the
 * manual `runNow` fire. The recurrence math (initial / advanced `nextRunAt`,
 * the human cadence summary, the create-form preview) is delegated wholesale to
 * the pure `@skipper/shared` recurrence engine; the scheduler timer owns the
 * actual firing (started in main boot).
 *
 * Convention (§14): procedures stay thin — input validation + a call into the
 * plain functions below — so the logic is `createCaller`-testable and reusable.
 */

// ---------------------------------------------------------------------------
// DTOs — the renderer-facing shapes (derive the cadence summary server-side so
// the list/preview don't have to re-parse the RRULE).
// ---------------------------------------------------------------------------

export interface AutomationListItem {
  id: string
  name: string
  agentId: string
  projectId: string
  recurrenceRule: string
  scheduleSummary: string
  timezone: string
  enabled: boolean
  nextRunAt: number | null
  createdAt: number
  updatedAt: number
}

export interface AutomationDetail extends AutomationListItem {
  prompt: string
  startAt: number
}

function toListItem(row: Automation): AutomationListItem {
  return {
    id: row.id,
    name: row.name,
    agentId: row.agentId,
    projectId: row.projectId,
    recurrenceRule: row.recurrenceRule,
    scheduleSummary: describeSchedule(row.recurrenceRule),
    timezone: row.timezone,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toDetail(row: Automation): AutomationDetail {
  return { ...toListItem(row), prompt: row.prompt, startAt: row.startAt }
}

// ---------------------------------------------------------------------------
// Plain service functions (the testable core; the router is one-liners over these).
// ---------------------------------------------------------------------------

function readAutomation(db: SkipperDatabase, id: string): Automation {
  const row = db.select().from(automations).where(eq(automations.id, id)).get()
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: `No automation ${id}` })
  return row
}

/** Snapshot the current prompt into the version history (newest-first by createdAt). */
function snapshotPrompt(
  db: SkipperDatabase,
  automationId: string,
  prompt: string,
  origin: AutomationPromptVersion["origin"],
): void {
  db.insert(automationPromptVersions).values({ automationId, prompt, origin }).run()
}

/** Compute the first/next fire instant for a recurrence, or null when exhausted. */
function computeNextRunAt(
  rule: string,
  startAt: number,
  timezone: string,
  after: number,
): number | null {
  const next = nextOccurrence(rule, {
    after: new Date(after),
    timezone,
    startAt: new Date(startAt),
  })
  return next ? next.getTime() : null
}

// ---------------------------------------------------------------------------
// Inputs.
// ---------------------------------------------------------------------------

const idInput = z.object({ id: z.string().min(1) })

const createInput = z.object({
  projectId: z.string().min(1),
  agentId: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string().default(""),
  recurrenceRule: z.string().min(1),
  /** Recurrence anchor (epoch ms); defaults to now at create time. */
  startAt: z.number().int().optional(),
  timezone: z.string().min(1),
  enabled: z.boolean().optional(),
})

const updateInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  prompt: z.string().optional(),
  recurrenceRule: z.string().min(1).optional(),
  startAt: z.number().int().optional(),
  timezone: z.string().min(1).optional(),
})

const previewInput = z.object({
  recurrenceRule: z.string().min(1),
  startAt: z.number().int().optional(),
  timezone: z.string().min(1),
})

export const automationsRouter = router({
  /** All automations, newest first, with their cadence summary. */
  list: publicProcedure.query(({ ctx }): AutomationListItem[] =>
    ctx.db.select().from(automations).orderBy(desc(automations.createdAt)).all().map(toListItem),
  ),

  /** One automation's full detail (incl. its current prompt + anchor). */
  get: publicProcedure
    .input(idInput)
    .query(({ ctx, input }): AutomationDetail => toDetail(readAutomation(ctx.db, input.id))),

  /**
   * Create an automation: validate the RRULE, compute the initial `nextRunAt`
   * (when enabled), insert, and snapshot the prompt as the first version.
   */
  create: publicProcedure.input(createInput).mutation(({ ctx, input }): AutomationDetail => {
    if (!isValidRrule(input.recurrenceRule)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid recurrence rule" })
    }
    const project = ctx.db.select().from(projects).where(eq(projects.id, input.projectId)).get()
    if (!project) {
      throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.projectId}` })
    }

    const now = Date.now()
    const startAt = input.startAt ?? now
    const enabled = input.enabled ?? true
    const nextRunAt = enabled
      ? computeNextRunAt(input.recurrenceRule, startAt, input.timezone, now)
      : null

    const inserted = ctx.db
      .insert(automations)
      .values({
        projectId: input.projectId,
        agentId: input.agentId,
        name: input.name,
        prompt: input.prompt,
        recurrenceRule: input.recurrenceRule,
        startAt,
        timezone: input.timezone,
        enabled,
        nextRunAt,
      })
      .returning()
      .get()

    snapshotPrompt(ctx.db, inserted.id, inserted.prompt, "edit")
    return toDetail(inserted)
  }),

  /**
   * Update an automation. Re-snapshots the prompt when it changes; recomputes
   * `nextRunAt` from now when any recurrence field (rule / anchor / timezone)
   * changes and the automation is enabled.
   */
  update: publicProcedure.input(updateInput).mutation(({ ctx, input }): AutomationDetail => {
    const current = readAutomation(ctx.db, input.id)

    const recurrenceRule = input.recurrenceRule?.trim() ?? current.recurrenceRule
    if (input.recurrenceRule !== undefined && !isValidRrule(recurrenceRule)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid recurrence rule" })
    }
    const startAt = input.startAt ?? current.startAt
    const timezone = input.timezone ?? current.timezone

    const recurrenceChanged =
      recurrenceRule !== current.recurrenceRule ||
      startAt !== current.startAt ||
      timezone !== current.timezone

    const promptChanged = input.prompt !== undefined && input.prompt !== current.prompt

    const nextRunAt =
      recurrenceChanged && current.enabled
        ? computeNextRunAt(recurrenceRule, startAt, timezone, Date.now())
        : current.nextRunAt

    const updated = ctx.db
      .update(automations)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(promptChanged ? { prompt: input.prompt } : {}),
        recurrenceRule,
        startAt,
        timezone,
        ...(recurrenceChanged ? { nextRunAt } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(automations.id, input.id))
      .returning()
      .get()

    if (promptChanged) snapshotPrompt(ctx.db, input.id, updated.prompt, "edit")
    return toDetail(updated)
  }),

  /**
   * Enable / disable. On enable, recompute `nextRunAt` from now so a paused
   * automation never fires a stale occurrence on resume; on disable, clear it.
   */
  setEnabled: publicProcedure
    .input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
    .mutation(({ ctx, input }): AutomationDetail => {
      const current = readAutomation(ctx.db, input.id)
      const nextRunAt = input.enabled
        ? computeNextRunAt(current.recurrenceRule, current.startAt, current.timezone, Date.now())
        : null
      const updated = ctx.db
        .update(automations)
        .set({ enabled: input.enabled, nextRunAt, updatedAt: Date.now() })
        .where(eq(automations.id, input.id))
        .returning()
        .get()
      return toDetail(updated)
    }),

  /** Delete an automation (runs + prompt versions cascade via the schema FK). */
  delete: publicProcedure.input(idInput).mutation(({ ctx, input }): { ok: true } => {
    readAutomation(ctx.db, input.id)
    ctx.db.delete(automations).where(eq(automations.id, input.id)).run()
    return { ok: true }
  }),

  /**
   * Fire an automation immediately via the same dispatch path the scheduler
   * uses. Manual runs use `now` as `scheduledFor` and never advance the regular
   * `nextRunAt` — the cadence is unaffected.
   */
  runNow: publicProcedure
    .input(idInput)
    .mutation(async ({ ctx, input }): Promise<{ runId: string | null }> => {
      const automation = readAutomation(ctx.db, input.id)
      const run = await dispatchAutomation(ctx, { automation, scheduledFor: Date.now() })
      return { runId: run?.id ?? null }
    }),

  /** The run log for an automation, newest first. */
  listRuns: publicProcedure
    .input(
      z.object({
        automationId: z.string().min(1),
        limit: z.number().int().positive().max(100).default(20),
      }),
    )
    .query(({ ctx, input }): AutomationRun[] =>
      ctx.db
        .select()
        .from(automationRuns)
        .where(eq(automationRuns.automationId, input.automationId))
        .orderBy(desc(automationRuns.createdAt))
        .limit(input.limit)
        .all(),
    ),

  /** The prompt revision history for an automation, newest first. */
  listPromptVersions: publicProcedure
    .input(z.object({ automationId: z.string().min(1) }))
    .query(({ ctx, input }): AutomationPromptVersion[] =>
      ctx.db
        .select()
        .from(automationPromptVersions)
        .where(eq(automationPromptVersions.automationId, input.automationId))
        .orderBy(desc(automationPromptVersions.createdAt))
        .all(),
    ),

  /**
   * Preview a recurrence for the create/edit form: its human cadence summary and
   * the next few occurrences (epoch ms), or empty when the rule is invalid. Pure
   * read — never touches the DB.
   */
  previewSchedule: publicProcedure
    .input(previewInput)
    .query(({ input }): { valid: boolean; summary: string; upcoming: number[] } => {
      if (!isValidRrule(input.recurrenceRule)) {
        return { valid: false, summary: "Custom", upcoming: [] }
      }
      const now = Date.now()
      const upcoming = upcomingOccurrences(input.recurrenceRule, {
        after: new Date(now),
        timezone: input.timezone,
        startAt: new Date(input.startAt ?? now),
        count: 5,
      }).map((d) => d.getTime())
      return {
        valid: true,
        summary: describeSchedule(input.recurrenceRule),
        upcoming,
      }
    }),
})
