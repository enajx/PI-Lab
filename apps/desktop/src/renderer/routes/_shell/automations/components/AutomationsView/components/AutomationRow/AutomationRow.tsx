import { Badge, Button } from "@skipper/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, ChevronRight, Play, Trash2 } from "lucide-react"
import { useState } from "react"
import { useTRPC } from "../../../../../../../trpc/react"
import type { AutomationListItem } from "../../../../../../../trpc/types"
import { RunsHistory } from "../RunsHistory"

interface AutomationRowProps {
  automation: AutomationListItem
  /** Resolved display name of the target project, when known. */
  projectName?: string
  /** Called after any mutation that changes the list (toggle / delete / run). */
  onChanged: () => void
}

/** Format an epoch-ms next-run instant for the row, or a dash when none. */
function formatNextRun(nextRunAt: number | null): string {
  if (nextRunAt === null) return "—"
  return new Date(nextRunAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

/**
 * One automation in the Workflows list (AGENTS.md "Scope"): name + cadence summary +
 * next run + an enabled toggle, with run-now / delete actions and an expandable
 * run history. Mutations call back to the parent to refresh the list.
 */
export function AutomationRow({ automation, projectName, onChanged }: AutomationRowProps) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)

  const setEnabled = useMutation(
    trpc.automations.setEnabled.mutationOptions({ onSuccess: () => onChanged() }),
  )
  const remove = useMutation(
    trpc.automations.delete.mutationOptions({ onSuccess: () => onChanged() }),
  )
  const runNow = useMutation(
    trpc.automations.runNow.mutationOptions({
      onSuccess: () => {
        onChanged()
        // Refresh this automation's run history if it is open.
        void queryClient.invalidateQueries({
          queryKey: trpc.automations.listRuns.queryKey({ automationId: automation.id }),
        })
      },
    }),
  )

  // Lightweight latest-run peek for the status dot (only when collapsed; the
  // expanded history fetches the full list).
  const runsQuery = useQuery(
    trpc.automations.listRuns.queryOptions({ automationId: automation.id, limit: 1 }),
  )
  const latest = runsQuery.data?.[0]

  return (
    <li
      data-testid="automation-row"
      data-automation-id={automation.id}
      data-enabled={automation.enabled}
      className="flex flex-col rounded-lg border border-border bg-card/40"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          data-testid="toggle-runs"
          aria-label={expanded ? "Hide runs" : "Show runs"}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span
              className="truncate font-medium text-foreground text-sm"
              data-testid="automation-name"
            >
              {automation.name}
            </span>
            {latest ? (
              <Badge
                data-testid="latest-run-state"
                variant={latest.state === "failed" ? "destructive" : "secondary"}
                className="shrink-0"
              >
                {latest.state}
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground text-xs">
            <span data-testid="schedule-summary">{automation.scheduleSummary}</span>
            {projectName ? <span className="truncate">· {projectName}</span> : null}
            <span data-testid="next-run">
              · Next: {automation.enabled ? formatNextRun(automation.nextRunAt) : "paused"}
            </span>
          </div>
        </div>

        <Button
          type="button"
          data-testid="run-now"
          variant="ghost"
          size="sm"
          disabled={runNow.isPending}
          onClick={() => runNow.mutate({ id: automation.id })}
          title="Run now"
        >
          <Play aria-hidden />
        </Button>

        <label
          data-testid="enabled-toggle"
          className="flex cursor-pointer select-none items-center gap-1.5 text-muted-foreground text-xs"
        >
          <input
            type="checkbox"
            data-testid="enabled-checkbox"
            className="size-3.5 accent-brand"
            checked={automation.enabled}
            disabled={setEnabled.isPending}
            onChange={(e) => setEnabled.mutate({ id: automation.id, enabled: e.target.checked })}
          />
          {automation.enabled ? "On" : "Off"}
        </label>

        <Button
          type="button"
          data-testid="delete-automation"
          variant="ghost"
          size="sm"
          disabled={remove.isPending}
          onClick={() => remove.mutate({ id: automation.id })}
          title="Delete"
        >
          <Trash2 aria-hidden className="text-destructive" />
        </Button>
      </div>

      {expanded ? (
        <div className="border-border border-t px-4 py-3">
          <RunsHistory automationId={automation.id} timezone={automation.timezone} />
        </div>
      ) : null}
    </li>
  )
}
