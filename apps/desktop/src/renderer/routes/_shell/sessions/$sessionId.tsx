import { createFileRoute, Link } from "@tanstack/react-router"
import { ArrowLeft } from "lucide-react"
import { z } from "zod"
import { Editor } from "../../../Editor"
import { Terminal } from "../../../Terminal"
import { useTRPCClient } from "../../../trpc/react"
import { KindBadge } from "../projects/$projectId"
import { RightSidebar } from "./components/RightSidebar"

/**
 * Session view (AGENTS.md §7) — the running agent surface. Keyed by the
 * `sessionId` returned from `sessions.start`; the backing `workspaceId`, the
 * chosen `kind`, and the originating `projectId` ride along as search params so
 * this view can render without re-deriving them.
 *
 * It shows three regions across the row:
 *   - the **built-in editor** (CodeMirror) — file tree + tabs + buffer, with ⌘S
 *     save and ⌘P quick-open, reading/writing through the `files` router. See
 *     `../../../Editor`.
 *   - the **terminal** attached to the existing session (attach mode — no
 *     spawn; the subscription replays scrollback). It uses the shared app-wide
 *     tRPC client so the observable subscription and Query reads share one IPC
 *     channel (AGENTS.md §12.1).
 *   - the **right sidebar** — a tabbed panel set (Research / Status / TODOs /
 *     Changes) reading the workspace's docs (`files.read`) and git state
 *     (`workspaces.*`). See `./components/RightSidebar`.
 *
 * The editor sits over the terminal in a stacked left column (editor on top,
 * terminal below) so both stay visible; the right sidebar keeps its own column.
 * A small kind badge surfaces the §8 policy outcome (branch vs worktree).
 */

const searchSchema = z.object({
  workspaceId: z.string().min(1),
  kind: z.enum(["branch", "worktree"]),
  projectId: z.string().min(1),
})

export const Route = createFileRoute("/_shell/sessions/$sessionId")({
  validateSearch: searchSchema,
  component: SessionView,
})

function SessionView() {
  const { sessionId } = Route.useParams()
  const { workspaceId, kind, projectId } = Route.useSearch()
  // Reuse the ONE app-wide tRPC client so the terminal's observable subscription
  // and the Query layer share a single IPC channel (AGENTS.md §12.1).
  const client = useTRPCClient()

  return (
    <div data-testid="session-view" className="flex h-full flex-col gap-3 p-4">
      <header className="flex items-center gap-3">
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          data-testid="session-back"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground text-sm transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Project
        </Link>
        <h1 className="font-semibold text-foreground text-sm">Agent session</h1>
        <KindBadge kind={kind} />
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_20rem] gap-3">
        <div className="grid min-h-0 grid-rows-[1fr_14rem] gap-3">
          <section className="min-h-0 overflow-hidden rounded-lg border border-border">
            <Editor workspaceId={workspaceId} />
          </section>
          <section className="min-h-0 overflow-hidden rounded-lg border border-border">
            <Terminal client={client} sessionId={sessionId} />
          </section>
        </div>

        <RightSidebar workspaceId={workspaceId} />
      </div>
    </div>
  )
}
