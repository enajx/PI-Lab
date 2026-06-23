import { useQuery } from "@tanstack/react-query"
import { useTRPC } from "../../../../../../../trpc/react"
import { ChangeList } from "../ChangeList"

const CHANGES_REFETCH_MS = 8_000

/**
 * Changes panel — the workspace's working-tree changes (staged/unstaged/
 * untracked), polled while the panel is open so it reflects an agent's edits.
 * Folded into the right-sidebar tab set so the panels are consistent (this is
 * the same `workspaces.changes` data the session view previously showed inline).
 */
export function ChangesPanel({ workspaceId }: { workspaceId: string }) {
  const trpc = useTRPC()
  const changesQuery = useQuery(
    trpc.workspaces.changes.queryOptions(
      { id: workspaceId },
      { refetchInterval: CHANGES_REFETCH_MS },
    ),
  )
  const changes = changesQuery.data ?? []

  return (
    <section data-testid="panel-changes" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="font-medium text-[10px] text-muted-foreground/60 uppercase tracking-wide">
          Changes
        </span>
        <span data-testid="changes-count" className="text-muted-foreground text-xs tabular-nums">
          {changes.length}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <ChangeList
          changes={changes}
          isPending={changesQuery.isPending}
          emptyTestId="changes-empty"
        />
      </div>
    </section>
  )
}
