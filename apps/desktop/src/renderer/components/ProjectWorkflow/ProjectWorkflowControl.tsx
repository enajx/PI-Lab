import type { WorkflowTask } from "@pi-lab/local-db"
import { cn } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CloudDownload, FileText, type LucideIcon } from "lucide-react"
import { useState } from "react"
import { useTRPC } from "../../trpc/react"
import { WorkflowResultDialog } from "./WorkflowResultDialog"

/**
 * The stateful control for a background project workflow ("Project summary" /
 * "Fetch remote experiments"), used on both the Dashboard card (compact,
 * icon-only) and the project-view header (labeled). It is driven entirely by
 * `workflows.status`, so both surfaces reflect the same live state and a run
 * started on one shows as running on the other.
 *
 * Every click opens the result window immediately, so the user can watch the run
 * live from the very first click. States:
 *   - `idle`    — never run; clicking starts a background run AND opens the window
 *                 on the live activity stream.
 *   - `running` — a run is in flight; the control shows a flowing orange sweep.
 *                 Clicking opens the result window to watch the agent's live output.
 *   - `done`    — a cached result exists; clicking opens the result window (the
 *                 report rendered as markdown, plus the run's log) AND re-checks
 *                 (the run returns the cache when the git state is unchanged, or
 *                 re-runs when it changed).
 *   - `error`   — the last run failed / timed out; clicking opens the window
 *                 (showing the failure) and re-checks.
 * The window also carries a Recheck button that forces a fresh run in place.
 */

type WorkflowControlState = "idle" | "running" | "done" | "error"

interface TaskMeta {
  icon: LucideIcon
  label: string
  /** Heading shown above the markdown-rendered report in the result window. */
  reportHeading: string
  guidance: string
}

const TASK_META: Record<WorkflowTask, TaskMeta> = {
  summary: {
    icon: FileText,
    label: "Project summary",
    reportHeading: "Project status",
    guidance: "Check RESEARCH.md for the updated status.",
  },
  "fetch-experiments": {
    icon: CloudDownload,
    label: "Fetch experiments",
    reportHeading: "Fetch results",
    guidance: "Fetched — check Analysis for the results.",
  },
}

// State tints. Only a *running* control is coloured — a brand-orange border
// behind the flowing orange sweep, so "thinking" is the one thing that stands out.
// A done control is deliberately neutral (no green — the result lives in the
// window); an errored one shows a subtle red so a failure is never hidden.
const STATE_TINT: Record<WorkflowControlState, string> = {
  idle: "border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground",
  running: "border-brand/60 text-foreground",
  done: "border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground",
  error: "border-red-500/50 text-red-600 hover:bg-red-500/10 dark:text-red-400",
}

export function ProjectWorkflowControl({
  projectId,
  projectName,
  task,
  variant,
  testId,
  instructions,
  disabled,
  disabledReason,
}: {
  projectId: string
  projectName: string
  task: WorkflowTask
  variant: "compact" | "labeled"
  /** Stable data-testid for the control (e.g. `project-card-summary`). */
  testId: string
  /** Extra prompt instructions for the fetch task (from Settings); ignored otherwise. */
  instructions?: string
  disabled?: boolean
  disabledReason?: string
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)

  const statusQuery = useQuery(
    trpc.workflows.status.queryOptions(
      { projectId },
      {
        // Poll only while a run is in flight, so both surfaces converge to the
        // completed state without polling forever.
        refetchInterval: (query) => {
          const data = query.state.data
          const anyRunning = Boolean(data?.summary?.running || data?.fetchExperiments?.running)
          return anyRunning ? 800 : false
        },
      },
    ),
  )

  const record = task === "summary" ? statusQuery.data?.summary : statusQuery.data?.fetchExperiments

  const invalidateStatus = () =>
    void queryClient.invalidateQueries({ queryKey: trpc.workflows.status.queryKey({ projectId }) })

  const run = useMutation(trpc.workflows.run.mutationOptions({ onSettled: invalidateStatus }))

  const running = run.isPending || Boolean(record?.running)
  const state: WorkflowControlState = running
    ? "running"
    : record?.errorMessage
      ? "error"
      : record
        ? "done"
        : "idle"

  const triggerRun = () => {
    if (running || disabled) return
    run.mutate({ projectId, task, ...(instructions !== undefined ? { instructions } : {}) })
  }

  const onClick = () => {
    if (disabled) return
    // Every click opens the window so the run is watchable from the first click.
    // triggerRun is a no-op while a run is already in flight (it guards on
    // `running`), so a running control just opens the window to watch; an idle
    // control starts a run and watches; a done/error control re-checks and shows
    // its cached result.
    setDialogOpen(true)
    triggerRun()
  }

  // Force a fresh run from inside the window (the Recheck button), bypassing the
  // git-state cache. Returns the mutation promise so the window can re-subscribe
  // to the new run's live stream once it has started.
  const recheck = () =>
    run.mutateAsync({
      projectId,
      task,
      force: true,
      ...(instructions !== undefined ? { instructions } : {}),
    })

  const meta = TASK_META[task]
  const Icon = meta.icon

  const ariaLabel =
    state === "running"
      ? `${meta.label} for ${projectName} — working`
      : state === "done"
        ? `${meta.label} for ${projectName} — done, view result`
        : state === "error"
          ? `${meta.label} for ${projectName} — failed, view error`
          : `${meta.label} for ${projectName}`

  const compact =
    "relative inline-flex h-7 flex-1 items-center justify-center rounded-md border outline-none transition-colors focus-visible:bg-accent/60 disabled:cursor-not-allowed"
  const labeled =
    "relative flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs outline-none transition-colors disabled:cursor-not-allowed"

  return (
    <>
      <button
        type="button"
        data-testid={testId}
        data-state={state}
        disabled={disabled}
        aria-label={ariaLabel}
        title={disabledReason ?? meta.label}
        data-feature-label={meta.label}
        data-feature-help={
          disabledReason ??
          `${meta.label} for ${projectName} — runs as a background task; click while running to watch its live output, or when done to view the result and re-check`
        }
        onClick={onClick}
        className={cn(variant === "compact" ? compact : labeled, STATE_TINT[state])}
      >
        {variant === "compact" ? (
          <Icon
            className={cn("size-4 shrink-0", state === "running" && "opacity-70")}
            aria-hidden
          />
        ) : (
          <>
            <Icon
              className={cn("size-3.5 shrink-0", state === "running" && "opacity-70")}
              aria-hidden
            />
            <span>{state === "running" ? "Working" : meta.label}</span>
          </>
        )}
        {/* The orange snake travelling around the edge — only while working. */}
        {state === "running" ? <span className="pi-lab-workflow-snake" aria-hidden /> : null}
      </button>

      {dialogOpen ? (
        <WorkflowResultDialog
          projectId={projectId}
          task={task}
          title={meta.label}
          reportHeading={meta.reportHeading}
          projectName={projectName}
          running={state === "running"}
          result={record?.result ?? ""}
          errorMessage={record?.errorMessage ?? null}
          lastCheckedAt={record?.lastCheckedAt ?? 0}
          guidance={meta.guidance}
          onRecheck={recheck}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </>
  )
}
