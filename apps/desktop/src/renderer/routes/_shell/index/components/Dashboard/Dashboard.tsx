import { cn } from "@pi-lab/ui"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { CaffeineControl } from "../../../../../caffeine"
import { CardGrid, ResizableCardGridItem } from "../../../../../components/CardGrid"
import { useTranslate } from "../../../../../i18n/language"
import { useShowHiddenProjects, useSidebarCollapsed } from "../../../../../preferences/preferences"
import { useTRPC } from "../../../../../trpc/react"
import { AddProjectMenu } from "../../../components/AddProjectMenu"
import { ProjectVisibilityToggle } from "../../../components/ProjectVisibilityToggle"
import { AgentStatusControl, titleBarControlClass, titleBarHeaderClass } from "../../../titleBar"
import { ProjectCard } from "../ProjectCard"

/**
 * The project-cards dashboard is the shell home. A responsive grid of large project cards, one per
 * opened project (most-recently-opened first, mirroring the sidebar), with a
 * bottom-corner handle that persists each card's independent grid span.
 *
 * This is the functional first pass: the structure (grid, card, gradient/
 * thumbnail/drag-drop, direct resizing) is here; the heavy visual polish and the
 * richer per-card contents are intentionally deferred.
 */
export function Dashboard() {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())
  const [collapsed] = useSidebarCollapsed()

  const projects = projectsQuery.data ?? []
  const hiddenCount =
    projectsQuery.data === undefined
      ? null
      : projects.filter((project) => Boolean(project.archivedAt)).length
  const [showHidden, setShowHidden] = useShowHiddenProjects(hiddenCount)
  const visibleProjects = showHidden ? projects : projects.filter((project) => !project.archivedAt)
  const invalidateProjects = () =>
    queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() })

  return (
    <div data-testid="dashboard" className="flex h-full flex-col">
      <header
        className={cn(
          "flex shrink-0 items-center justify-between gap-4 border-border border-b py-3",
          titleBarHeaderClass(collapsed),
        )}
      >
        <h1 className="font-semibold text-foreground text-sm tracking-tight">
          {t("Projects Dashboard")}
        </h1>
        <div className={cn("flex shrink-0 items-center gap-3", titleBarControlClass(collapsed))}>
          <ProjectVisibilityToggle
            hiddenCount={hiddenCount ?? 0}
            showHidden={showHidden}
            collapsed={false}
            testId="dashboard-show-hidden-projects"
            onToggle={() => setShowHidden(!showHidden)}
          />
          <AgentStatusControl />
          <CaffeineControl />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {projects.length === 0 ? (
          <p
            data-testid="dashboard-empty"
            className="text-muted-foreground text-sm leading-relaxed"
          >
            {t("No projects yet.")}
          </p>
        ) : visibleProjects.length === 0 ? (
          <p
            data-testid="dashboard-empty"
            className="text-muted-foreground text-sm leading-relaxed"
          >
            {t("All projects are hidden. Use Show hidden to restore one.")}
          </p>
        ) : null}
        <CardGrid
          surface="dashboard"
          cardIds={
            projectsQuery.data === undefined ? null : visibleProjects.map((project) => project.id)
          }
          testId="dashboard-grid"
          className="gap-4"
        >
          {visibleProjects.map((project) => (
            <ResizableCardGridItem
              key={project.id}
              cardId={project.id}
              label={project.name}
              testId="project-card-grid-item"
            >
              <ProjectCard project={project} />
            </ResizableCardGridItem>
          ))}
          <AddProjectMenu variant="dashboard-card" onAdded={() => void invalidateProjects()} />
        </CardGrid>
      </div>
    </div>
  )
}
