import { type AutomationRunState, automationRuns, type PiLabDatabase } from "@pi-lab/local-db"
import { and, eq, inArray } from "drizzle-orm"
import { nativeNotificationBody, nativeText } from "../i18n/nativeLanguage"
import type { NotificationRequest } from "../notifications"

/**
 * Producers that complete without an interactive PTY. `chat` is deliberately
 * only a typed lifecycle seam: PI Lab does not implement native chat here.
 */
export type ExternalWorkflowSource = "noninteractive" | "chat"

export interface WorkflowLifecycleTarget {
  source: ExternalWorkflowSource
  workflowId: string
  runId: string
  workflowName: string
}

export interface WorkflowLifecycleReporter {
  started: () => boolean
  completed: () => boolean
  failed: (reason: string) => boolean
}

/**
 * Contract a future native-chat producer must satisfy. It receives an already
 * claimed run and reports only real runtime lifecycle events through this
 * reporter; this module owns durable state and exact-run notification routing.
 */
export interface FutureChatWorkflowLifecycleContract {
  source: "chat"
  workflowId: string
  runId: string
  lifecycle: WorkflowLifecycleReporter
}

export interface WorkflowLifecycleDependencies {
  db: PiLabDatabase
  notifications: {
    notify: (request: NotificationRequest) => unknown
  }
  now?: () => number
}

function sourceLabel(source: ExternalWorkflowSource): "chat" | "non-interactive" {
  return source === "chat" ? "chat" : "non-interactive"
}

/**
 * Persist and announce one-shot workflow lifecycle transitions. Every method
 * is transition-guarded, so duplicate process/chat callbacks cannot duplicate
 * banners or rewrite a terminal state.
 */
export function createWorkflowLifecycleReporter(
  dependencies: WorkflowLifecycleDependencies,
  target: WorkflowLifecycleTarget,
): WorkflowLifecycleReporter {
  const now = dependencies.now ?? Date.now

  const transition = (
    from: AutomationRunState[],
    state: AutomationRunState,
    values: { launchedAt?: number; completedAt?: number; error?: string | null },
    request: Omit<NotificationRequest, "target">,
  ): boolean => {
    const updated = dependencies.db
      .update(automationRuns)
      .set({ state, ...values })
      .where(
        and(
          eq(automationRuns.id, target.runId),
          eq(automationRuns.automationId, target.workflowId),
          inArray(automationRuns.state, from),
        ),
      )
      .returning({ id: automationRuns.id })
      .get()
    if (!updated) return false

    dependencies.notifications.notify({
      ...request,
      target: {
        type: "workflow",
        workflowId: target.workflowId,
        runId: target.runId,
      },
    })
    return true
  }

  return {
    started: () => {
      const startedAt = now()
      return transition(
        ["pending"],
        "running",
        { launchedAt: startedAt, error: null },
        {
          eventType: "workflowStart",
          title: nativeText("Workflow started"),
          body: nativeNotificationBody(
            "workflowStarted",
            target.workflowName,
            sourceLabel(target.source),
          ),
        },
      )
    },
    completed: () =>
      transition(
        ["running"],
        "completed",
        { completedAt: now(), error: null },
        {
          eventType: "workflowCompletion",
          title: nativeText("Workflow completed"),
          body: nativeNotificationBody("workflowCompleted", target.workflowName),
        },
      ),
    failed: (reason: string) =>
      transition(
        ["pending", "running"],
        "failed",
        { completedAt: now(), error: reason },
        {
          eventType: "workflowFailure",
          title: nativeText("Workflow failed"),
          body: reason,
        },
      ),
  }
}
