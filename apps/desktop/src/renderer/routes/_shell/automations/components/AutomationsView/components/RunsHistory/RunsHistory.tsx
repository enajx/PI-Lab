import { Badge } from "@pi-lab/ui"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { useTRPC } from "../../../../../../../trpc/react"

interface RunsHistoryProps {
  automationId: string
  /** Timezone the automation is scheduled in (for rendering instants). */
  timezone: string
  targetRunId?: string
}

function formatInstant(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

/**
 * Run history for one workflow, newest first. Interactive and one-shot runs
 * progress from pending to running and completed/failed; legacy launched rows
 * remain readable. A notification target focuses its exact run.
 */
export function RunsHistory({ automationId, targetRunId }: RunsHistoryProps) {
  const trpc = useTRPC()
  const runsQuery = useQuery(
    trpc.automations.listRuns.queryOptions({ automationId, limit: 20, targetRunId }),
  )
  const runs = runsQuery.data ?? []
  const targetRef = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (!targetRunId || !runs.some((run) => run.id === targetRunId)) return
    targetRef.current?.scrollIntoView?.({ block: "center" })
    targetRef.current?.focus({ preventScroll: true })
  }, [runs, targetRunId])

  if (runsQuery.isLoading) {
    return <p className="text-muted-foreground text-xs">Loading runs…</p>
  }
  if (runs.length === 0) {
    return (
      <p data-testid="runs-empty" className="text-muted-foreground text-xs">
        No runs yet.
      </p>
    )
  }

  return (
    <ul data-testid="runs-history" className="flex flex-col gap-1.5">
      {runs.map((run) => (
        <li
          ref={run.id === targetRunId ? targetRef : undefined}
          tabIndex={run.id === targetRunId ? -1 : undefined}
          key={run.id}
          data-testid="run-item"
          data-run-state={run.state}
          data-highlighted={run.id === targetRunId}
          className={`flex items-center gap-2 rounded text-xs ${
            run.id === targetRunId ? "bg-brand/15 px-2 py-1 ring-1 ring-brand/60" : ""
          }`}
        >
          <Badge
            variant={run.state === "failed" ? "destructive" : "secondary"}
            className="shrink-0"
          >
            {run.state}
          </Badge>
          <span className="text-muted-foreground">{formatInstant(run.scheduledFor)}</span>
          {run.error ? (
            <span className="cursor-text select-text truncate text-destructive" title={run.error}>
              {run.error}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
