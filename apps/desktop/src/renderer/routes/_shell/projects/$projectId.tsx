import type { Workspace } from "@skipper/local-db"
import { Button } from "@skipper/ui"
import { useMutation, useQuery } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { GitBranch, GitFork, Play } from "lucide-react"
import { useTRPC } from "../../../trpc/react"
import { readAgentIdOverride } from "../utils/agentIdOverride"

/**
 * Project route (AGENTS.md §7) — a project is an opened local git repo. It shows
 * the project's name + path, lists its workspaces (branch / worktree), and offers
 * an "Open agent" action that starts an external CLI agent session via
 * `sessions.start` (which applies the §8 worktree policy: main checkout by
 * default, a fresh worktree on concurrency / when `worktreePerAgent` is on).
 *
 * On a successful start we navigate to the session view keyed by the returned
 * `sessionId`, carrying the `workspaceId` + chosen `kind` as search params so that
 * view can render the attached terminal, the changes panel, and a kind badge
 * (so the policy is visible). The agent id comes from the default agent, with a
 * `?agentId` test seam (AGENTS.md §14) so the E2E can launch the deterministic
 * test agent.
 */
export const Route = createFileRoute("/_shell/projects/$projectId")({
  component: ProjectView,
})

function ProjectView() {
  const { projectId } = Route.useParams()
  const trpc = useTRPC()
  const navigate = useNavigate()

  const projectQuery = useQuery(trpc.projects.get.queryOptions({ id: projectId }))
  const workspacesQuery = useQuery(trpc.workspaces.list.queryOptions({ projectId }))

  const startSession = useMutation(
    trpc.sessions.start.mutationOptions({
      onSuccess: (result) => {
        void navigate({
          to: "/sessions/$sessionId",
          params: { sessionId: result.sessionId },
          search: { workspaceId: result.workspaceId, kind: result.kind, projectId },
        })
      },
    }),
  )

  const openAgent = () => {
    startSession.mutate({ projectId, agentId: readAgentIdOverride() })
  }

  if (projectQuery.isError) {
    return (
      <div className="p-8">
        <p data-testid="project-error" className="cursor-text select-text text-destructive text-sm">
          {projectQuery.error.message}
        </p>
      </div>
    )
  }

  const project = projectQuery.data
  const workspaces = workspacesQuery.data ?? []

  return (
    <div data-testid="project-view" className="flex h-full flex-col gap-6 p-8">
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="truncate font-semibold text-foreground text-xl tracking-tight">
            {project?.name ?? "Loading…"}
          </h1>
          {project ? (
            <p className="cursor-text select-text truncate text-muted-foreground text-sm">
              {project.repoPath}
            </p>
          ) : null}
        </div>
        <Button
          data-testid="open-agent"
          onClick={openAgent}
          disabled={startSession.isPending || !project}
        >
          <Play aria-hidden />
          Open agent
        </Button>
      </header>

      {startSession.isError ? (
        <p className="cursor-text select-text text-destructive text-sm">
          {startSession.error.message}
        </p>
      ) : null}

      <section className="flex min-h-0 flex-1 flex-col gap-2">
        <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Workspaces
        </h2>
        <ul
          data-testid="workspaces-list"
          className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto"
        >
          {workspaces.length === 0 ? (
            <li data-testid="workspaces-empty" className="text-muted-foreground text-sm">
              No workspaces yet — open an agent to create one.
            </li>
          ) : (
            workspaces.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} />)
          )}
        </ul>
      </section>
    </div>
  )
}

/** One workspace row: its name, branch, and a kind badge (branch vs worktree). */
function WorkspaceRow({ workspace }: { workspace: Workspace }) {
  return (
    <li
      data-testid="workspace-item"
      data-kind={workspace.kind}
      className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
    >
      <KindBadge kind={workspace.kind} />
      <span className="min-w-0 flex-1 truncate text-foreground text-sm">{workspace.name}</span>
      {workspace.branch ? (
        <span className="shrink-0 text-muted-foreground text-xs">{workspace.branch}</span>
      ) : null}
    </li>
  )
}

/** Small badge surfacing the §8 policy outcome — branch (main checkout) vs worktree. */
export function KindBadge({ kind }: { kind: Workspace["kind"] }) {
  const isWorktree = kind === "worktree"
  return (
    <span
      data-testid="kind-badge"
      data-kind={kind}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground text-xs"
    >
      {isWorktree ? (
        <GitFork className="size-3" aria-hidden />
      ) : (
        <GitBranch className="size-3" aria-hidden />
      )}
      {isWorktree ? "worktree" : "branch"}
    </span>
  )
}
