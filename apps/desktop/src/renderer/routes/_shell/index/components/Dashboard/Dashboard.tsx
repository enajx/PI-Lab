import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { cn } from "@pi-lab/ui"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type ComponentProps, useCallback, useEffect, useRef, useState } from "react"
import { CaffeineControl } from "../../../../../caffeine"
import { CardGrid, ResizableCardGridItem } from "../../../../../components/CardGrid"
import { useTranslate } from "../../../../../i18n/language"
import { useShowHiddenProjects, useSidebarCollapsed } from "../../../../../preferences/preferences"
import { useTRPC } from "../../../../../trpc/react"
import { useAddProjectController } from "../../../components/AddProjectController"
import { AddProjectMenu } from "../../../components/AddProjectMenu"
import { ProjectVisibilityToggle } from "../../../components/ProjectVisibilityToggle"
import { useProjectReorder } from "../../../components/useProjectReorder"
import { AgentStatusControl, titleBarControlClass, titleBarHeaderClass } from "../../../titleBar"
import { ProjectCard } from "../ProjectCard"

type DashboardProject = ComponentProps<typeof ProjectCard>["project"]

/** A pointer must move this far before a press becomes a card drag, so a click still opens. */
const DRAG_ACTIVATION_DISTANCE_PX = 6

/** How long the other cards take to slide out of the way while one is dragged. */
const SLIDE_TRANSITION = { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" }

/**
 * One project card that can be dragged (by its thumbnail or body) or moved with the
 * keyboard (focus it, Space, arrow keys, Space) to a new place in the grid.
 */
function SortableProjectCard({ project }: { project: DashboardProject }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id, transition: SLIDE_TRANSITION })
  return (
    <ResizableCardGridItem
      ref={(element) => {
        setNodeRef(element)
        setActivatorNodeRef(element)
      }}
      cardId={project.id}
      label={project.name}
      testId="project-card-grid-item"
      {...attributes}
      {...listeners}
      data-dragging={isDragging}
      className={cn(
        "rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isDragging && "z-30 cursor-grabbing shadow-xl",
      )}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <ProjectCard project={project} />
    </ResizableCardGridItem>
  )
}

/**
 * The project-cards dashboard is the shell home. A responsive grid of large project cards, one per
 * opened project in the saved project order (shared with the sidebar), with a
 * bottom-corner handle that sets one shared card width and height. Cards are moved by
 * dragging them (dnd-kit sortable grid); the New project card stays last and fixed.
 *
 * This is the functional first pass: the structure (grid, card, gradient/
 * thumbnail/drag-drop, direct resizing) is here; the heavy visual polish and the
 * richer per-card contents are intentionally deferred.
 */
export function Dashboard() {
  const t = useTranslate()
  const trpc = useTRPC()
  const navigate = useNavigate()
  const { openAddProject } = useAddProjectController()
  const trayRequestHandled = useRef(false)
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
  const [reorderError, setReorderError] = useState<string | null>(null)
  const reorderProjects = useProjectReorder(setReorderError)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE_PX } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const visibleIds = visibleProjects.map((project) => project.id)
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    setReorderError(null)
    reorderProjects(
      arrayMove(
        visibleIds,
        visibleIds.indexOf(String(active.id)),
        visibleIds.indexOf(String(over.id)),
      ),
    )
  }
  const invalidateProjects = useCallback(
    () => queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() }),
    [queryClient, trpc],
  )

  useEffect(() => {
    if (trayRequestHandled.current) return
    const search = window.location.hash.split("?", 2)[1]
    if (!search || !new URLSearchParams(search).has("newProject")) return
    trayRequestHandled.current = true
    openAddProject({
      onAdded: (project) => {
        void invalidateProjects()
        void navigate({ to: "/projects/$projectId", params: { projectId: project.id } })
      },
    })
    const cleanHash = window.location.hash.split("?", 1)[0]
    window.history.replaceState(null, "", `${window.location.href.split("#", 1)[0]}${cleanHash}`)
  }, [openAddProject, navigate, invalidateProjects])

  return (
    <div data-testid="dashboard" className="flex h-full flex-col">
      <header
        className={cn(
          "flex shrink-0 items-center justify-between gap-4 border-border border-b py-3",
          titleBarHeaderClass(collapsed),
        )}
      >
        <h1 className="text-foreground text-sm tracking-tight">{t("Projects Dashboard")}</h1>
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

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-12 pb-6">
        {/* With no projects the New project card alone is shown, with no text above it. */}
        {projects.length > 0 && visibleProjects.length === 0 ? (
          <p
            data-testid="dashboard-empty"
            className="text-muted-foreground text-sm leading-relaxed"
          >
            {t("All projects are hidden. Use Show hidden to restore one.")}
          </p>
        ) : null}
        {reorderError ? (
          <p
            role="alert"
            data-testid="dashboard-reorder-error"
            className="mb-3 text-destructive text-xs"
          >
            {reorderError}
          </p>
        ) : null}
        <CardGrid
          surface="dashboard"
          cardIds={
            projectsQuery.data === undefined ? null : visibleProjects.map((project) => project.id)
          }
          testId="dashboard-grid"
          className="gap-6"
        >
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={visibleIds} strategy={rectSortingStrategy}>
              {visibleProjects.map((project) => (
                <SortableProjectCard key={project.id} project={project} />
              ))}
            </SortableContext>
          </DndContext>
          <AddProjectMenu variant="dashboard-card" onAdded={() => void invalidateProjects()} />
        </CardGrid>
      </div>
    </div>
  )
}
