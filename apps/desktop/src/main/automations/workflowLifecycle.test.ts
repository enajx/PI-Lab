import { automationRuns, automations } from "@pi-lab/local-db"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { NotificationRequest } from "../notifications"
import { createHarness, type Harness } from "../trpc/testHarness"
import { createWorkflowLifecycleReporter } from "./workflowLifecycle"

let h: Harness
let automationId: string
let runId: string

beforeEach(async () => {
  h = await createHarness()
  const project = await h.caller.projects.open({ path: h.repoDir })
  const automation = h.db
    .insert(automations)
    .values({
      projectId: project.id,
      agentId: "claude-code",
      name: "One-shot review",
      prompt: "review",
      recurrenceRule: "FREQ=DAILY",
      timezone: "UTC",
    })
    .returning()
    .get()
  const run = h.db
    .insert(automationRuns)
    .values({
      automationId: automation.id,
      scheduledFor: 1_900_000_000_000,
      state: "pending",
    })
    .returning()
    .get()
  automationId = automation.id
  runId = run.id
})

afterEach(async () => {
  await h.dispose()
})

describe("workflow lifecycle reporter", () => {
  test("future chat producers use the same exact-run start/completion contract", () => {
    const notify = vi.fn((_request: NotificationRequest) => "delivered" as const)
    const reporter = createWorkflowLifecycleReporter(
      {
        db: h.db,
        notifications: { notify },
        now: (() => {
          let now = 100
          return () => ++now
        })(),
      },
      {
        source: "chat",
        workflowId: automationId,
        runId,
        workflowName: "One-shot review",
      },
    )

    expect(reporter.started()).toBe(true)
    expect(reporter.started()).toBe(false)
    expect(reporter.completed()).toBe(true)
    expect(reporter.completed()).toBe(false)

    const stored = h.db.select().from(automationRuns).where(eq(automationRuns.id, runId)).get()
    expect(stored).toMatchObject({
      state: "completed",
      launchedAt: 101,
      completedAt: 103,
      error: null,
    })
    expect(notify.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({
        eventType: "workflowStart",
        target: { type: "workflow", workflowId: automationId, runId },
      }),
      expect.objectContaining({
        eventType: "workflowCompletion",
        target: { type: "workflow", workflowId: automationId, runId },
      }),
    ])
  })

  test("failure is terminal, visible, and not duplicated", () => {
    const notify = vi.fn((_request: NotificationRequest) => "delivered" as const)
    const reporter = createWorkflowLifecycleReporter(
      { db: h.db, notifications: { notify }, now: () => 777 },
      {
        source: "noninteractive",
        workflowId: automationId,
        runId,
        workflowName: "One-shot review",
      },
    )

    expect(reporter.started()).toBe(true)
    expect(reporter.failed("codex exited with code 17")).toBe(true)
    expect(reporter.failed("duplicate")).toBe(false)
    expect(reporter.completed()).toBe(false)

    expect(
      h.db.select().from(automationRuns).where(eq(automationRuns.id, runId)).get(),
    ).toMatchObject({
      state: "failed",
      completedAt: 777,
      error: "codex exited with code 17",
    })
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        eventType: "workflowFailure",
        body: "codex exited with code 17",
        target: { type: "workflow", workflowId: automationId, runId },
      }),
    )
  })

  test("refuses a mismatched workflow/run target instead of misrouting a notification", () => {
    const notify = vi.fn(() => "delivered" as const)
    const reporter = createWorkflowLifecycleReporter(
      { db: h.db, notifications: { notify }, now: () => 999 },
      {
        source: "chat",
        workflowId: "another-workflow",
        runId,
        workflowName: "Wrong target",
      },
    )

    expect(reporter.started()).toBe(false)
    expect(
      h.db.select().from(automationRuns).where(eq(automationRuns.id, runId)).get()?.state,
    ).toBe("pending")
    expect(notify).not.toHaveBeenCalled()
  })
})
