import type { Project } from "@skipper/local-db"
import { Button, cn } from "@skipper/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useParams, useRouterState } from "@tanstack/react-router"
import { Compass, FolderPlus, Workflow } from "lucide-react"
import { useEffect, useRef } from "react"
import { useTRPC } from "../../../../trpc/react"
import { scienceNavItems } from "../../science/components/scienceNavItems"
import { readOpenProjectOverride } from "../../utils/openProjectOverride"

/**
 * Left sidebar (AGENTS.md §7, md/02 — projects are the ground unit). It lists the
 * opened projects (most-recently-opened first), offers an "Add project" action,
 * shows the empty state when there are none, and navigates to a project's route
 * on click, marking the active one.
 *
 * "Add project" opens the native folder picker (`system.pickDirectory`) and, on a
 * chosen path, opens it as a project (`projects.open`) and invalidates the list.
 * The E2E can't drive a native dialog, so a `?openProject=<abs path>` seam
 * (AGENTS.md §14) opens a known path once on mount instead.
 *
 * The list is a bounded flex child with its own scroll (`min-h-0 overflow-y-auto`,
 * AGENTS.md §12.3 — never a nested Radix ScrollArea).
 */
export function Sidebar() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())

  const invalidateProjects = () =>
    queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() })

  const pickDirectory = useMutation(trpc.system.pickDirectory.mutationOptions())
  const openProject = useMutation(
    trpc.projects.open.mutationOptions({ onSuccess: () => void invalidateProjects() }),
  )

  const addProject = async () => {
    const path = await pickDirectory.mutateAsync()
    if (!path) return
    await openProject.mutateAsync({ path })
  }

  useOpenProjectSeam((path) => {
    void openProject.mutateAsync({ path })
  })

  const projects = projectsQuery.data ?? []

  return (
    <aside
      data-testid="app-sidebar"
      className="flex w-60 shrink-0 flex-col gap-3 border-sidebar-border border-r bg-sidebar p-3"
    >
      <div className="flex items-center gap-2 px-1 text-sidebar-foreground">
        <Compass className="size-5 text-brand" aria-hidden />
        <span className="font-semibold text-sm tracking-tight">Skipper</span>
      </div>

      <Button
        data-testid="add-project"
        variant="outline"
        size="sm"
        className="w-full justify-start"
        disabled={pickDirectory.isPending || openProject.isPending}
        onClick={() => void addProject()}
      >
        <FolderPlus aria-hidden />
        Add project
      </Button>

      <nav
        aria-label="Projects"
        className="-mr-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pr-1"
      >
        {projects.length === 0 ? (
          <p
            data-testid="projects-empty"
            className="px-1 py-2 text-muted-foreground text-xs leading-relaxed"
          >
            No projects yet.
          </p>
        ) : (
          projects.map((project) => <ProjectItem key={project.id} project={project} />)
        )}
      </nav>

      <WorkflowsNav />

      <ScienceNav />
    </aside>
  )
}

/**
 * Top-level Workflows (Automations) nav entry (AGENTS.md §1 — a v1 feature now).
 * A single link that highlights when the automations route is active.
 */
function WorkflowsNav() {
  const { location } = useRouterState()
  const isActive = location.pathname.startsWith("/automations")
  return (
    <nav
      aria-label="Workflows"
      className="flex shrink-0 flex-col gap-0.5 border-sidebar-border border-t pt-3"
    >
      <Link
        to="/automations"
        data-testid="nav-automations"
        data-active={isActive}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
          isActive
            ? "bg-accent font-medium text-accent-foreground"
            : "text-sidebar-foreground hover:bg-accent/60",
        )}
      >
        <Workflow className="size-4" aria-hidden />
        <span className="flex-1 truncate">Workflows</span>
      </Link>
    </nav>
  )
}

/**
 * Science section of the sidebar (AGENTS.md §1 / §7): a small nav driven by the
 * `scienceNavItems` registry. Built ("ready") tabs are links that highlight when
 * active; not-yet-built tabs render as a disabled "soon" row so the full v1 shape
 * is visible without dead routes. Only Cluster is wired in this step.
 */
function ScienceNav() {
  const { location } = useRouterState()
  const pathname = location.pathname

  return (
    <nav
      aria-label="Science"
      data-testid="science-nav"
      className="flex shrink-0 flex-col gap-0.5 border-sidebar-border border-t pt-3"
    >
      <span className="px-2 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Science
      </span>
      {scienceNavItems.map((item) => {
        const Icon = item.icon
        if (!item.ready || !item.to) {
          return (
            <span
              key={item.id}
              data-testid="science-nav-item"
              data-science-tab={item.id}
              data-ready={false}
              aria-disabled
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground/50 text-sm"
            >
              <Icon className="size-4" aria-hidden />
              <span className="flex-1 truncate">{item.label}</span>
              <span className="text-[10px] uppercase tracking-wide">soon</span>
            </span>
          )
        }
        const isActive = pathname.startsWith(item.to)
        return (
          <Link
            key={item.id}
            to={item.to}
            data-testid="science-nav-item"
            data-science-tab={item.id}
            data-ready={true}
            data-active={isActive}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
              isActive
                ? "bg-accent font-medium text-accent-foreground"
                : "text-sidebar-foreground hover:bg-accent/60",
            )}
          >
            <Icon className="size-4" aria-hidden />
            <span className="flex-1 truncate">{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

/** A single project row that links to its route and highlights when active. */
function ProjectItem({ project }: { project: Project }) {
  const params = useParams({ strict: false }) as { projectId?: string }
  const isActive = params.projectId === project.id

  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      data-testid="project-item"
      data-project-id={project.id}
      data-active={isActive}
      className={cn(
        "truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        isActive
          ? "bg-accent font-medium text-accent-foreground"
          : "text-sidebar-foreground hover:bg-accent/60",
      )}
      title={project.repoPath}
    >
      {project.name}
    </Link>
  )
}

/**
 * Fire the open-project test seam exactly once on mount when `?openProject` is
 * present (AGENTS.md §14). A ref guard survives React 19 StrictMode's double
 * effect so the project is never opened twice.
 */
function useOpenProjectSeam(open: (path: string) => void): void {
  const firedRef = useRef(false)
  // The latest callback in a ref so the once-only effect needn't depend on it.
  const openRef = useRef(open)
  openRef.current = open

  useEffect(() => {
    if (firedRef.current) return
    const path = readOpenProjectOverride()
    if (!path) return
    firedRef.current = true
    openRef.current(path)
  }, [])
}
