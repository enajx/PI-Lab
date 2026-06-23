import { useQuery } from "@tanstack/react-query"
import { GitBranch, GitFork } from "lucide-react"
import { useTRPC } from "../../../../../../../trpc/react"
import { ChangeList } from "../ChangeList"

const STATUS_REFETCH_MS = 8_000

/**
 * Status panel — the workspace's git/working state at a glance: its name, the
 * worktree-vs-branch kind (the §8 policy outcome), the branch it operates on,
 * and a summary of the working tree (a staged/changed count plus the changed
 * paths). Changes are polled on an interval so the panel reflects what an agent
 * touches while it runs.
 *
 * Reads `workspaces.get` (name/kind/branch — cheap DB row) and
 * `workspaces.changes` (the same git status the Changes panel uses). Bounded
 * flex + native scroll per AGENTS.md §12.3.
 */
export function StatusPanel({ workspaceId }: { workspaceId: string }) {
  const trpc = useTRPC()
  const workspaceQuery = useQuery(trpc.workspaces.get.queryOptions({ id: workspaceId }))
  const changesQuery = useQuery(
    trpc.workspaces.changes.queryOptions(
      { id: workspaceId },
      { refetchInterval: STATUS_REFETCH_MS },
    ),
  )

  const workspace = workspaceQuery.data
  const changes = changesQuery.data ?? []
  const stagedCount = changes.filter((c) => c.staged).length

  return (
    <section data-testid="panel-status" className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <dl className="flex flex-col">
          <StatusRow
            icon={
              workspace?.kind === "worktree" ? (
                <GitFork className="size-3.5" />
              ) : (
                <GitBranch className="size-3.5" />
              )
            }
            label="Workspace"
            value={workspace?.name ?? "…"}
          />
          <StatusRow
            label="Type"
            value={workspace ? (workspace.kind === "worktree" ? "Worktree" : "Branch") : "…"}
            testId="status-kind"
            dataAttrs={workspace ? { "data-kind": workspace.kind } : undefined}
          />
          <StatusRow
            icon={<GitBranch className="size-3.5" />}
            label="Branch"
            value={workspace?.branch ?? "…"}
            mono
          />
        </dl>

        <div className="px-3 pt-3 pb-1">
          <div className="flex items-center justify-between">
            <span className="font-medium text-[10px] text-muted-foreground/60 uppercase tracking-wide">
              Working tree
            </span>
            <span
              data-testid="status-changes-count"
              className="text-muted-foreground text-xs tabular-nums"
            >
              {changes.length} changed · {stagedCount} staged
            </span>
          </div>
        </div>

        <div className="px-3 pb-3">
          <ChangeList
            changes={changes}
            isPending={changesQuery.isPending}
            emptyTestId="status-changes-empty"
          />
        </div>
      </div>
    </section>
  )
}

/** One labelled line in the status table. */
function StatusRow({
  icon,
  label,
  value,
  mono,
  testId,
  dataAttrs,
}: {
  icon?: React.ReactNode
  label: string
  value: React.ReactNode
  mono?: boolean
  testId?: string
  dataAttrs?: Record<string, string>
}) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 text-xs"
      data-testid={testId}
      {...dataAttrs}
    >
      {icon ? <span className="shrink-0 text-muted-foreground/70">{icon}</span> : null}
      <dt className="shrink-0 text-muted-foreground/70">{label}</dt>
      <dd
        className={`ml-auto min-w-0 truncate text-right text-foreground ${mono ? "font-mono" : ""}`}
      >
        {value}
      </dd>
    </div>
  )
}
