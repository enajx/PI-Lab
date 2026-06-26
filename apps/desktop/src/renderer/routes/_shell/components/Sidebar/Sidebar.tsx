import type { Project } from "@skipper/local-db"
import { Button, cn } from "@skipper/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useParams, useRouterState } from "@tanstack/react-router"
import {
  FilePlus2,
  FolderOpen,
  FolderPlus,
  GitFork,
  LayoutDashboard,
  PanelLeft,
  PanelLeftClose,
  Settings,
  Trash2,
  Waypoints,
} from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useNavOrder,
  useProjectOrder,
  useSidebarCollapsed,
  useSidebarWidth,
} from "../../../../preferences/preferences"
import { useTheme } from "../../../../providers/ThemeProvider"
import { useTRPC } from "../../../../trpc/react"
import { type ScienceNavItem, scienceNavItems } from "../../science/components/scienceNavItems"
import { readOpenProjectOverride } from "../../utils/openProjectOverride"

/**
 * The Skipper app mark shown in the sidebar's draggable title-bar band. Two
 * monochrome variants — the dark-on-light glyph for the light theme and its
 * negative (light-on-dark) for the dark theme — so the mark always reads against
 * the sidebar. Loaded as asset URLs via the `new URL(..., import.meta.url)` pattern
 * Vite resolves in dev and in the packaged `file://` renderer.
 */
const APP_LOGO = new URL("../../../../assets/icon_bw_alpha.png", import.meta.url).href
const APP_LOGO_NEGATIVE = new URL("../../../../assets/icon_bw_negative_alpha.png", import.meta.url)
  .href

/**
 * Shared layout/typography for every sidebar nav row (Dashboard, Science tabs,
 * Workflows, Settings) so they render at exactly one size — `text-sm`, same
 * weight/line-height, `size-4` icons. State colours are applied on top via
 * `navStateClass`. Keeping this in one place guarantees no row drifts visually.
 */
const navRowClass = "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors"

/** Active/inactive colours for a nav row, layered on top of `navRowClass`. */
const navStateClass = (isActive: boolean): string =>
  isActive
    ? "bg-accent font-medium text-accent-foreground"
    : "text-sidebar-foreground hover:bg-accent/60"

/**
 * Unified workspace nav entries (Task 2/6): the science tabs followed by Workflows,
 * rendered as ONE `gap-0.5` list so Workflows sits flush with its peers (the old
 * gap-3 between two separate `<nav>`s made it read as a detached block). Workflows
 * reuses the {@link ScienceNavItem} shape so the whole list shares one row renderer.
 */
const navItems: ScienceNavItem[] = [
  ...scienceNavItems,
  { id: "workflows", label: "Workflows", icon: Waypoints, ready: true, to: "/automations" },
]

/** Drag props applied to a reorderable row (native HTML5 drag-and-drop). */
type RowDragProps = Pick<
  React.HTMLAttributes<HTMLElement>,
  "onDragStart" | "onDragOver" | "onDrop" | "onDragEnd"
> & { draggable: boolean }

/**
 * What a row needs to participate in drag-reorder: the DOM drag handlers plus a
 * className that draws the drop-position indicator line on the row currently being
 * hovered (an inset 2px line at its top edge for drop-before / bottom edge for
 * drop-after). Empty `dropClass` when the row isn't the active drop target.
 */
interface RowReorder {
  dragProps: RowDragProps
  dropClass: string
}

/**
 * Order `items` by a persisted id list: ids present in `order` come first (in that
 * order), then any ids not yet stored, in their natural order — so freshly-added
 * entries still appear. Stable for both the nav list and the project list.
 */
function orderById<T extends { id: string }>(items: T[], order: string[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const seen = new Set<string>()
  const result: T[] = []
  for (const id of order) {
    const item = byId.get(id)
    if (item && !seen.has(id)) {
      result.push(item)
      seen.add(id)
    }
  }
  for (const item of items) {
    if (!seen.has(item.id)) {
      result.push(item)
      seen.add(item.id)
    }
  }
  return result
}

/** Move `dragged` to `target`'s slot within `ids` (after it when `after`); new array. */
function moveId(ids: string[], dragged: string, target: string, after: boolean): string[] {
  const next = ids.slice()
  const from = next.indexOf(dragged)
  if (from === -1) return ids
  next.splice(from, 1)
  let to = next.indexOf(target)
  if (to === -1) return ids
  if (after) to += 1
  next.splice(to, 0, dragged)
  return next
}

/**
 * Native drag-to-reorder within a single list (Task 6): tracks the dragged id and a
 * drop target (with a before/after side from the pointer position), and on drop
 * persists the new full id order via `persist`. Each list owns its own hook instance,
 * so dragging never crosses between the nav and the projects. The drag uses the
 * `"move"` effect (so the cursor shows a move, not a copy "+"), and the hovered target
 * row gets an inset line marking exactly where the row will land (Task 3). The dragged
 * row stays a `<Link>` so a plain click still navigates.
 */
function useDragReorder(
  orderedIds: string[],
  persist: (ids: string[]) => void,
): (id: string) => RowReorder {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null)

  const reset = () => {
    setDraggingId(null)
    setDropTarget(null)
  }

  return (id: string): RowReorder => {
    const isTarget = draggingId !== null && draggingId !== id && dropTarget?.id === id
    const dropClass = isTarget
      ? dropTarget?.after
        ? "shadow-[inset_0_-2px_0_0_var(--color-primary)]"
        : "shadow-[inset_0_2px_0_0_var(--color-primary)]"
      : ""
    return {
      dropClass,
      dragProps: {
        draggable: true,
        onDragStart: (event) => {
          setDraggingId(id)
          event.dataTransfer.effectAllowed = "move"
        },
        onDragOver: (event) => {
          if (draggingId === null) return
          event.preventDefault()
          event.dataTransfer.dropEffect = "move"
          const rect = event.currentTarget.getBoundingClientRect()
          setDropTarget({ id, after: event.clientY > rect.top + rect.height / 2 })
        },
        onDrop: (event) => {
          event.preventDefault()
          if (draggingId !== null && draggingId !== id) {
            persist(moveId(orderedIds, draggingId, id, dropTarget?.after ?? false))
          }
          reset()
        },
        onDragEnd: reset,
      },
    }
  }
}

/** A right-click target on a project row (the menu is rendered once at the sidebar root). */
interface ProjectMenuState {
  id: string
  name: string
  x: number
  y: number
}

/**
 * Left sidebar (docs/architecture.md (renderer), md/02 — projects are the ground unit).
 * Top to bottom: a "Dashboard" entry (carrying the divider below it), one unified
 * workspace nav (Library, Analysis, Cluster, Tasks, Skills, Workflows) rendered as a
 * single `gap-0.5` list, a divider-topped "Projects" label + the opened projects (the
 * scroll region), then a tight bottom cluster of "Add project" + Settings under a single
 * divider. Both the workspace nav and the project list are drag-reorderable within
 * themselves (`useNavOrder` / `useProjectOrder`); reordering never crosses between the
 * two, shows a move cursor (not a copy "+"), and marks the drop slot with a line.
 * Right-clicking a project offers "Remove from Skipper" (removes the row only, never the
 * files on disk).
 *
 * The sidebar collapses to a narrow icon-only rail (toggled via `useSidebarCollapsed`):
 * every row keeps its icon and gains a native `title` tooltip, and project rows show
 * a first-letter badge. Clicking still navigates in either state, and the collapsed rail
 * does not support drag-reorder. The collapse toggle lives in the sidebar's own header
 * (the draggable title-bar region that clears the macOS traffic lights), so the sidebar
 * is one continuous gray column at a single header level. The expanded width is
 * continuously resizable by dragging the right edge (`EdgeResizeHandle`); dragging below
 * the min width snaps to the collapsed rail.
 *
 * "Add project" is a dropdown popover (`AddProjectMenu`) with three ways in: open an
 * existing folder (`system.pickDirectory` → `projects.open`), clone a git repo
 * (`projects.clone`), or start from a template (`projects.createFromTemplate`); each
 * invalidates the project list. The E2E can't drive a native dialog, so a
 * `?openProject=<abs path>` seam (docs/testing-and-build.md) opens a known path once
 * on mount instead.
 *
 * The list is a bounded flex child with its own scroll (`min-h-0 overflow-y-auto`,
 * AGENTS.md Pitfalls #3 — never a nested Radix ScrollArea).
 */
export function Sidebar() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  const [width, setWidth] = useSidebarWidth()

  const invalidateProjects = () =>
    queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() })

  const openProject = useMutation(
    trpc.projects.open.mutationOptions({ onSuccess: () => void invalidateProjects() }),
  )
  // Remove only the project row (the working tree on disk is never touched).
  const removeProject = useMutation(
    trpc.projects.remove.mutationOptions({ onSuccess: () => void invalidateProjects() }),
  )
  const [projectMenu, setProjectMenu] = useState<ProjectMenuState | null>(null)

  useOpenProjectSeam((path) => {
    void openProject.mutateAsync({ path })
  })

  const projects = projectsQuery.data ?? []
  const [projectOrder, setProjectOrder] = useProjectOrder()
  const orderedProjects = orderById(projects, projectOrder)
  const projectRowProps = useDragReorder(
    orderedProjects.map((project) => project.id),
    setProjectOrder,
  )

  return (
    <aside
      data-testid="app-sidebar"
      data-collapsed={collapsed}
      className={cn(
        "relative flex shrink-0 flex-col border-sidebar-border border-r bg-sidebar",
        collapsed && "w-14",
      )}
      style={collapsed ? undefined : { width }}
    >
      {/* Window top-left: the draggable title-bar region (`app-drag`) that clears the
          macOS traffic lights (x16,y18). It also hosts the decorative Skipper app mark
          (`SidebarLogo`, theme-aware): EXPANDED it sits flush at the right edge (`ml-auto`,
          just inside `pr-2`, at the main-panel boundary) with the collapse toggle inline
          just right of the lights; COLLAPSED the 56px rail is too narrow for the toggle at
          the traffic-light level, so the logo is centered in the rail here and the toggle
          drops into the rail below (first nav item). Either way the header lives inside the
          sidebar, so it's one continuous gray column at a single header level — no
          full-width bar stacked over the page. */}
      <div
        className={cn(
          "app-drag flex h-11 shrink-0 items-center",
          collapsed ? "justify-center px-2" : "pl-20 pr-2",
        )}
      >
        {collapsed ? (
          <SidebarLogo />
        ) : (
          <>
            <CollapseToggle collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
            <SidebarLogo className="ml-auto" />
          </>
        )}
      </div>

      {/* Nav body — padded; the header above is full-bleed for the traffic lights. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 pb-3">
        {collapsed ? (
          <div className="flex justify-center">
            <CollapseToggle collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
          </div>
        ) : null}
        <DashboardNav collapsed={collapsed} />

        <WorkspaceNav collapsed={collapsed} />

        {/* Projects — a divider line above the section (Task 1) separates it from the
          workspace nav; the list itself is the scroll region. */}
        <nav
          aria-label="Projects"
          className="-mr-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto border-sidebar-border border-t pr-1 pt-3"
        >
          {collapsed ? null : (
            <span className="px-2 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Projects
            </span>
          )}
          {orderedProjects.length === 0 ? (
            collapsed ? null : (
              <p
                data-testid="projects-empty"
                className="px-1 py-2 text-muted-foreground text-xs leading-relaxed"
              >
                No projects yet.
              </p>
            )
          ) : (
            orderedProjects.map((project) => (
              <ProjectItem
                key={project.id}
                project={project}
                collapsed={collapsed}
                reorder={collapsed ? null : projectRowProps(project.id)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setProjectMenu({
                    id: project.id,
                    name: project.name,
                    x: event.clientX,
                    y: event.clientY,
                  })
                }}
              />
            ))
          )}
        </nav>

        {/* Bottom cluster: "Add project" then Settings, under a top divider and with a
          compact divider between the two as well (no large blank). Add project is a
          dropdown with three ways in (folder / clone / template). */}
        <div className="flex shrink-0 flex-col gap-1.5 border-sidebar-border border-t pt-3">
          <AddProjectMenu collapsed={collapsed} onAdded={invalidateProjects} />
          <SettingsNav collapsed={collapsed} />
        </div>
      </div>

      <EdgeResizeHandle
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        width={width}
        setWidth={setWidth}
      />

      <ProjectContextMenu
        menu={projectMenu}
        onClose={() => setProjectMenu(null)}
        onRemove={(id) => {
          removeProject.mutate({ id })
          setProjectMenu(null)
        }}
      />
    </aside>
  )
}

/**
 * The sidebar collapse/expand toggle. Shared between the header (expanded, inline after
 * the traffic lights) and the rail's first slot (collapsed, where it cannot sit at the
 * traffic-light level without overflowing into the page header).
 */
function CollapseToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-testid="sidebar-collapse-toggle"
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-pressed={collapsed}
      className="app-no-drag size-7 text-sidebar-foreground"
      onClick={onToggle}
    >
      {collapsed ? <PanelLeft aria-hidden /> : <PanelLeftClose aria-hidden />}
    </Button>
  )
}

/**
 * The decorative Skipper app mark in the title-bar band. Picks the theme-matched
 * variant from the live resolved mode (`useTheme().theme` is only `light`/`dark`, so
 * it is the resolved mode directly): the dark-on-light glyph in light, its negative in
 * dark. Purely decorative — `aria-hidden` with an empty `alt`, no link or handler.
 * `draggable={false}` stops the native image drag from hijacking the window drag, and
 * it deliberately carries NO `app-no-drag` so window dragging passes straight through.
 */
function SidebarLogo({ className }: { className?: string }) {
  const { theme } = useTheme()
  const src = theme === "dark" ? APP_LOGO_NEGATIVE : APP_LOGO
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      data-testid="sidebar-app-logo"
      className={cn("size-5 select-none", className)}
    />
  )
}

/**
 * The right-click menu for a project row, rendered once at the sidebar root and
 * positioned at the cursor. Its only action removes the project from the app
 * (`projects.remove` — the DB row only; the folder on disk is left untouched).
 * Closes on outside mousedown or Escape; clicks inside (the action) don't close it
 * early thanks to the `rootRef` containment check.
 */
function ProjectContextMenu({
  menu,
  onClose,
  onRemove,
}: {
  menu: ProjectMenuState | null
  onClose: () => void
  onRemove: (id: string) => void
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menu) return
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("mousedown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("mousedown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [menu, onClose])

  if (!menu) return null
  return (
    <div
      ref={rootRef}
      data-testid="project-context-menu"
      role="menu"
      className="fixed z-50 w-60 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
      style={{ left: menu.x, top: menu.y }}
    >
      <button
        type="button"
        role="menuitem"
        data-testid="project-remove"
        onClick={() => onRemove(menu.id)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-destructive text-sm transition-colors hover:bg-destructive/10"
      >
        <Trash2 className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">Remove from Skipper</span>
      </button>
      <p className="cursor-text select-text px-2 py-1 text-[11px] text-muted-foreground leading-snug">
        Removes “{menu.name}” from the app only — the files on disk are left untouched.
      </p>
    </div>
  )
}

/**
 * Add-project dropdown popover with three ways to create a project (mirrors the
 * editor/right-sidebar menus: an `aria-haspopup="menu"` trigger and an absolutely
 * positioned `role="menu"` that closes on outside mousedown or Escape). "Open from
 * folder" picks a directory and runs `projects.open`; "Start from template" picks the
 * target folder and runs `projects.createFromTemplate` directly (no name form); "Clone
 * from git repo" reveals an inline form that gathers the URL, picks a parent directory,
 * then clones. Each success invalidates the project list via {@link onAdded}; any
 * mutation error surfaces as selectable text inside the popover (no silent failures).
 * Collapsed, the trigger is an icon-only button.
 */
function AddProjectMenu({ collapsed, onAdded }: { collapsed: boolean; onAdded: () => void }) {
  const trpc = useTRPC()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<"menu" | "clone">("menu")
  const [url, setUrl] = useState("")
  const rootRef = useRef<HTMLDivElement | null>(null)
  const labelId = useId()

  const onSuccess = () => {
    onAdded()
    setOpen(false)
  }
  const pickDirectory = useMutation(trpc.system.pickDirectory.mutationOptions())
  const openProject = useMutation(trpc.projects.open.mutationOptions({ onSuccess }))
  const cloneProject = useMutation(trpc.projects.clone.mutationOptions({ onSuccess }))
  const templateProject = useMutation(
    trpc.projects.createFromTemplate.mutationOptions({ onSuccess }),
  )

  const pending =
    pickDirectory.isPending ||
    openProject.isPending ||
    cloneProject.isPending ||
    templateProject.isPending
  const error =
    pickDirectory.error ?? openProject.error ?? cloneProject.error ?? templateProject.error

  // Reset the popover to its menu state whenever it closes, so reopening always
  // starts fresh (no stale form values or lingering error).
  useEffect(() => {
    if (open) return
    setMode("menu")
    setUrl("")
    pickDirectory.reset()
    openProject.reset()
    cloneProject.reset()
    templateProject.reset()
  }, [open, pickDirectory.reset, openProject.reset, cloneProject.reset, templateProject.reset])

  // Close on outside click or Escape so the menu behaves like a real popover.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("mousedown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("mousedown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  const openFromFolder = async () => {
    const path = await pickDirectory.mutateAsync()
    if (!path) return
    await openProject.mutateAsync({ path })
  }
  const submitClone = async () => {
    const trimmed = url.trim()
    if (!trimmed) return
    const parentDir = await pickDirectory.mutateAsync()
    if (!parentDir) return
    await cloneProject.mutateAsync({ url: trimmed, parentDir })
  }
  const startFromTemplate = async () => {
    const targetDir = await pickDirectory.mutateAsync()
    if (!targetDir) return
    await templateProject.mutateAsync({ targetDir })
  }

  return (
    <div ref={rootRef} className="relative">
      <Button
        data-testid="add-project"
        variant="ghost"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn("w-full text-sm", collapsed ? "justify-center px-0" : "justify-start px-2")}
        title={collapsed ? "Add project" : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <FolderPlus aria-hidden />
        {collapsed ? null : "Add project"}
      </Button>

      {open ? (
        <div
          data-testid="add-project-menu"
          role="menu"
          aria-labelledby={labelId}
          className="absolute bottom-11 left-0 z-50 w-64 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
        >
          <p id={labelId} className="px-2 py-1 font-medium text-muted-foreground text-xs">
            Add project
          </p>

          {mode === "menu" ? (
            <>
              <MenuItem
                testId="add-project-folder"
                icon={FolderOpen}
                label="Open from folder"
                onClick={() => void openFromFolder()}
                disabled={pending}
              />
              <MenuItem
                testId="add-project-clone"
                icon={GitFork}
                label="Clone from git repo"
                onClick={() => setMode("clone")}
                disabled={pending}
              />
              <MenuItem
                testId="add-project-template"
                icon={FilePlus2}
                label="Start from template"
                onClick={() => void startFromTemplate()}
                disabled={pending}
              />
            </>
          ) : null}

          {mode === "clone" ? (
            <form
              data-testid="add-project-clone-form"
              className="flex flex-col gap-2 p-1.5"
              onSubmit={(event) => {
                event.preventDefault()
                void submitClone()
              }}
            >
              <label
                className="font-medium text-muted-foreground text-xs"
                htmlFor={`${labelId}-url`}
              >
                Git repository URL
              </label>
              <input
                id={`${labelId}-url`}
                data-testid="add-project-clone-url"
                type="text"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://github.com/owner/repo.git"
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
              />
              <Button type="submit" size="sm" disabled={pending || url.trim().length === 0}>
                Choose folder & clone
              </Button>
            </form>
          ) : null}

          {error ? (
            <p
              data-testid="add-project-error"
              className="cursor-text select-text px-2 py-1 text-destructive text-xs leading-relaxed"
            >
              {error.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** A single action row in the Add-project menu (icon + label). */
function MenuItem({
  testId,
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  testId: string
  icon: typeof FolderOpen
  label: string
  onClick: () => void
  disabled: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50"
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

/**
 * A thin handle on the sidebar's right edge that continuously resizes the
 * expanded width. A pointer drag computes a target width from the starting
 * width (or the 56px rail when collapsed) plus the horizontal delta, then either
 * snaps to the collapsed icon rail (below ~150px, so labels never get cramped) or
 * sets the clamped expanded width live as the user drags. Uses pointer capture so
 * the gesture survives the cursor leaving the strip, and tears the move/up
 * listeners down on release. It never throws.
 */
function EdgeResizeHandle({
  collapsed,
  setCollapsed,
  width,
  setWidth,
}: {
  collapsed: boolean
  setCollapsed: (next: boolean) => void
  width: number
  setWidth: (next: number) => void
}) {
  const COLLAPSE_SNAP_WIDTH = 150
  const COLLAPSED_RAIL_WIDTH = 56

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = collapsed ? COLLAPSED_RAIL_WIDTH : width
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)

    const onMove = (move: PointerEvent) => {
      const next = startWidth + (move.clientX - startX)
      if (next < COLLAPSE_SNAP_WIDTH) {
        setCollapsed(true)
        return
      }
      setCollapsed(false)
      setWidth(Math.min(Math.max(next, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH))
    }
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", cleanup)
      window.removeEventListener("pointercancel", cleanup)
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", cleanup)
    window.addEventListener("pointercancel", cleanup)
  }

  return (
    <div
      data-testid="sidebar-edge-drag"
      aria-hidden
      className="app-no-drag absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-sidebar-border"
      onPointerDown={onPointerDown}
    />
  )
}

/**
 * Dashboard entry — the top-of-sidebar link to the project-cards Dashboard ("/"),
 * active only on an exact "/" match. It carries the single divider that separates
 * it from the science/nav group below (Task 6): a `border-b` + bottom padding, so
 * Dashboard reads as its own block above the Library/Analysis/Cluster/… group.
 */
function DashboardNav({ collapsed }: { collapsed: boolean }) {
  const { location } = useRouterState()
  const isActive = location.pathname === "/"
  return (
    <div className="shrink-0 border-sidebar-border border-b pb-3">
      <Link
        to="/"
        data-testid="nav-dashboard"
        data-active={isActive}
        title={collapsed ? "Dashboard" : undefined}
        className={cn(navRowClass, collapsed && "justify-center", navStateClass(isActive))}
      >
        <LayoutDashboard className="size-4" aria-hidden />
        {collapsed ? null : <span className="flex-1 truncate">Dashboard</span>}
      </Link>
    </div>
  )
}

/**
 * Unified workspace nav (AGENTS.md "Scope" / docs/architecture.md (renderer)): the
 * `scienceNavItems` registry plus Workflows, rendered as ONE `gap-0.5` list so every
 * row — Workflows included — sits flush with its peers (Task 2/6: the old gap-3
 * between two separate `<nav>`s was what made Workflows read as a detached block).
 * Built ("ready") tabs are links that highlight when active; not-yet-built tabs render
 * as a disabled "soon" row so the full v1 shape is visible without dead routes.
 *
 * When expanded, every row is drag-reorderable within this list (`useNavOrder`): the
 * cursor shows a move (not a copy "+") and the hovered target row shows a drop line; the
 * collapsed rail keeps a fixed icon order (no DnD). It renders directly below the
 * Dashboard divider — the divider above the group lives on `DashboardNav`.
 */
function WorkspaceNav({ collapsed }: { collapsed: boolean }) {
  const { location } = useRouterState()
  const pathname = location.pathname
  const [navOrder, setNavOrder] = useNavOrder()
  const ordered = orderById(navItems, navOrder)
  const navRowProps = useDragReorder(
    ordered.map((item) => item.id),
    setNavOrder,
  )

  return (
    <nav
      aria-label="Workspace"
      data-testid="science-nav"
      className="flex shrink-0 flex-col gap-0.5"
    >
      {ordered.map((item) => {
        const Icon = item.icon
        const testId = item.id === "workflows" ? "nav-automations" : "science-nav-item"
        const reorder = collapsed ? null : navRowProps(item.id)
        if (!item.ready || !item.to) {
          return (
            <span
              key={item.id}
              data-testid={testId}
              data-science-tab={item.id}
              data-ready={false}
              aria-disabled
              title={collapsed ? `${item.label} (soon)` : undefined}
              className={cn(
                navRowClass,
                "text-muted-foreground/50",
                collapsed ? "cursor-default justify-center" : "cursor-grab",
                reorder?.dropClass,
              )}
              {...reorder?.dragProps}
            >
              <Icon className="size-4" aria-hidden />
              {collapsed ? null : (
                <>
                  <span className="flex-1 truncate">{item.label}</span>
                  <span className="text-[10px] uppercase tracking-wide">soon</span>
                </>
              )}
            </span>
          )
        }
        const isActive = pathname.startsWith(item.to)
        return (
          <Link
            key={item.id}
            to={item.to}
            data-testid={testId}
            data-science-tab={item.id}
            data-ready={true}
            data-active={isActive}
            title={collapsed ? item.label : undefined}
            className={cn(
              navRowClass,
              collapsed ? "justify-center" : "cursor-grab",
              navStateClass(isActive),
              reorder?.dropClass,
            )}
            {...reorder?.dragProps}
          >
            <Icon className="size-4" aria-hidden />
            {collapsed ? null : <span className="flex-1 truncate">{item.label}</span>}
          </Link>
        )
      })}
    </nav>
  )
}

/** Settings entry (also reachable via ⌘,) — the lower row of the bottom cluster. */
function SettingsNav({ collapsed }: { collapsed: boolean }) {
  const { location } = useRouterState()
  const isActive = location.pathname.startsWith("/settings")
  return (
    <nav
      aria-label="Settings"
      className="flex shrink-0 flex-col gap-0.5 border-sidebar-border border-t pt-2"
    >
      <Link
        to="/settings"
        data-testid="nav-settings"
        data-active={isActive}
        title={collapsed ? "Settings" : undefined}
        className={cn(navRowClass, collapsed && "justify-center", navStateClass(isActive))}
      >
        <Settings className="size-4" aria-hidden />
        {collapsed ? null : <span className="flex-1 truncate">Settings</span>}
      </Link>
    </nav>
  )
}

/**
 * A single project row that links to its route and highlights when active. When
 * the sidebar is collapsed it renders an icon-sized first-letter badge with a
 * `title` tooltip carrying the full name; expanded it shows the name and is
 * drag-reorderable via {@link reorder} (the collapsed rail passes none). Right-clicking
 * opens the remove menu via {@link onContextMenu} in either state.
 */
function ProjectItem({
  project,
  collapsed,
  reorder,
  onContextMenu,
}: {
  project: Project
  collapsed: boolean
  reorder?: RowReorder | null
  onContextMenu: (event: React.MouseEvent) => void
}) {
  const params = useParams({ strict: false }) as { projectId?: string }
  const isActive = params.projectId === project.id

  if (collapsed) {
    return (
      <Link
        to="/projects/$projectId"
        params={{ projectId: project.id }}
        data-testid="project-item"
        data-project-id={project.id}
        data-active={isActive}
        onContextMenu={onContextMenu}
        className={cn(
          "flex justify-center rounded-md py-1.5 transition-colors",
          navStateClass(isActive),
        )}
        title={project.name}
      >
        <span
          aria-hidden
          className={cn(
            "flex size-6 items-center justify-center rounded-md text-xs font-medium uppercase",
            isActive ? "bg-accent-foreground/10" : "bg-accent",
          )}
        >
          {project.name.trim().charAt(0) || "?"}
        </span>
        <span className="sr-only">{project.name}</span>
      </Link>
    )
  }

  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      data-testid="project-item"
      data-project-id={project.id}
      data-active={isActive}
      onContextMenu={onContextMenu}
      className={cn(
        "truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        reorder && "cursor-grab",
        reorder?.dropClass,
        navStateClass(isActive),
      )}
      title={project.repoPath}
      {...reorder?.dragProps}
    >
      {project.name}
    </Link>
  )
}

/**
 * Fire the open-project test seam exactly once on mount when `?openProject` is
 * present (docs/testing-and-build.md). A ref guard survives React 19 StrictMode's double
 * effect so the project is never opened twice.
 */
function useOpenProjectSeam(open: (path: string) => void): void {
  const firedRef = useRef(false)
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
