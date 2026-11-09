import type { WorkflowTask } from "@pi-lab/local-db"

/** Every background workflow task, in a fixed order. */
const WORKFLOW_TASKS: readonly WorkflowTask[] = [
  "summary",
  "fetch-experiments",
  "plan-research",
  "latex-merge",
]

/**
 * In-memory "currently running" tracker, keyed by `${projectId}:${task}`. The DB
 * only ever stores the last COMPLETED result, so this is the sole source of the
 * transient running flag `status` reports. It lives for the process lifetime, so
 * on startup nothing is running — exactly the desired reset. Kept in its own
 * module (no imports) so the sessions router can read it without an import cycle.
 */
export const runningTasks = new Set<string>()

/** The {@link runningTasks} key of one (project, task). */
export const runningKey = (projectId: string, task: WorkflowTask): string => `${projectId}:${task}`

/** The background workflow tasks running right now for a project. */
export function runningProjectWorkflowTasks(projectId: string): WorkflowTask[] {
  return WORKFLOW_TASKS.filter((task) => runningTasks.has(runningKey(projectId, task)))
}
