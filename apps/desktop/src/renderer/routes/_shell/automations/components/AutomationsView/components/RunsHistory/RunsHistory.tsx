import { Badge } from "@skipper/ui"
import { useQuery } from "@tanstack/react-query"
import { useTRPC } from "../../../../../../../trpc/react"

interface RunsHistoryProps {
  automationId: string
  /** Timezone the automation is scheduled in (for rendering instants). */
  timezone: string
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
 * Run history for one automation (AGENTS.md "Scope"): the launch log, newest first.
 * v1 records launch-only outcomes — `launched` (with the spun-up workspace),
 * `failed` (with the error), or `pending` (claimed but not yet launched). No
 * agent-completion tracking.
 */
export function RunsHistory({ automationId }: RunsHistoryProps) {
  const trpc = useTRPC()
  const runsQuery = useQuery(trpc.automations.listRuns.queryOptions({ automationId, limit: 20 }))
  const runs = runsQuery.data ?? []

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
          key={run.id}
          data-testid="run-item"
          data-run-state={run.state}
          className="flex items-center gap-2 text-xs"
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
