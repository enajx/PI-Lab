import { cn } from "@pi-lab/ui"
import { useQuery } from "@tanstack/react-query"
import { CaffeineControl } from "../../../../../caffeine"
import { CardGrid, ResizableCardGridItem } from "../../../../../components/CardGrid"
import { useSidebarCollapsed } from "../../../../../preferences/preferences"
import { useTRPC } from "../../../../../trpc/react"
import { titleBarControlClass, titleBarHeaderClass } from "../../../titleBar"
import { ProjectCard } from "../ProjectCard"

/**
 * The project-cards dashboard — the shell home (md/02 — "Dashboard & project
 * cards", md/engineering/architecture.md (renderer); git history (build phases), P7). A responsive grid of large project cards, one per
 * opened project (most-recently-opened first, mirroring the sidebar), with a
 * bottom-corner handle that persists each card's independent grid span.
 *
 * This is the functional first pass: the structure (grid, card, gradient/
 * thumbnail/drag-drop, direct resizing) is here; the heavy visual polish and the
 * richer per-card contents are intentionally deferred.
 */
export function Dashboard() {
  const trpc = useTRPC()
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())
  const [collapsed] = useSidebarCollapsed()

  const projects = projectsQuery.data ?? []

  return (
    <div data-testid="dashboard" className="flex h-full flex-col">
      <header
        className={cn(
          "flex shrink-0 items-center justify-between gap-4 border-border border-b py-3",
          titleBarHeaderClass(collapsed),
        )}
      >
        <h1 className="font-semibold text-foreground text-sm tracking-tight">Projects Dashboard</h1>
        <div className={cn("flex shrink-0 items-center gap-3", titleBarControlClass(collapsed))}>
          <CaffeineControl />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {projects.length === 0 ? (
          <p
            data-testid="dashboard-empty"
            className="text-muted-foreground text-sm leading-relaxed"
          >
            No projects yet.
          </p>
        ) : null}
        <CardGrid
          surface="dashboard"
          cardIds={projectsQuery.data === undefined ? null : projects.map((project) => project.id)}
          testId="dashboard-grid"
          className="gap-4"
          hidden={projects.length === 0}
        >
          {projects.map((project) => (
            <ResizableCardGridItem
              key={project.id}
              cardId={project.id}
              label={project.name}
              testId="project-card-grid-item"
            >
              <ProjectCard project={project} />
            </ResizableCardGridItem>
          ))}
        </CardGrid>
      </div>
    </div>
  )
}
