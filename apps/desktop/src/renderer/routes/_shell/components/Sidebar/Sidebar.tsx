import { Button, cn } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useParams, useRouterState } from "@tanstack/react-router"
import {
  Bot,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  FileCode2,
  LayoutDashboard,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Settings,
  Trash2,
  Waypoints,
  X,
} from "lucide-react"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { LatexText } from "../../../../components/LatexText"
import { usePopupDismiss } from "../../../../components/usePopupDismiss"
import { useInterfaceLanguage, useTranslate } from "../../../../i18n/language"
import {
  dismissNonGitNotice,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useNavOrder,
  useRestoreProjectTabs,
  useShowHiddenProjects,
  useShownNavEntries,
  useSidebarCollapsed,
  useSidebarFeatureHelp,
  useSidebarWidth,
} from "../../../../preferences/preferences"
import {
  readActiveQuickTarget,
  subscribeQuickEditor,
} from "../../../../QuickEditor/quickEditorState"
import { useDisplayPath } from "../../../../trpc/displayPath"
import { useTRPC } from "../../../../trpc/react"
import type { ProjectSummary } from "../../../../trpc/useProjectThumbnail"
import { useProjectThumbnail } from "../../../../trpc/useProjectThumbnail"
import { useProjectActivityStates } from "../../-ProjectActivity"
import { rememberSettingsReturnRoute } from "../../-settingsReturnRoute"
import { EditProjectDialog } from "../../index/components/ProjectCard/EditProjectDialog"
import type { ProjectState } from "../../index/utils/deriveProjectState"
import {
  type ProjectWorkspaceState,
  readProjectWorkspaceState,
  subscribeProjectWorkspaceState,
  writeProjectWorkspaceState,
} from "../../projects/-workspaceState"
import { KindBadge } from "../../projects/components/KindBadge"
import { type ScienceNavItem, scienceNavItems } from "../../science/components/scienceNavItems"
import { readOpenProjectOverride } from "../../utils/openProjectOverride"
import { AddProjectMenu } from "../AddProjectMenu"
import { ProjectVisibilityToggle } from "../ProjectVisibilityToggle"
import { useProjectReorder } from "../useProjectReorder"

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
    ? "bg-selected text-selected-accent-foreground"
    : "text-sidebar-foreground hover:bg-accent/60"

/**
 * Default only; a persisted drag order takes priority. Editor is not listed: it is
 * hidden by default and, when shown, goes to the bottom unless the user dragged it.
 */
const DEFAULT_NAV_ORDER = [
  "tasks",
  "library",
  "analysis",
  "latex",
  "skills",
  "workflows",
  "cluster",
]

/** Shared row definitions; the default and saved orders determine their positions. */
const navItems: ScienceNavItem[] = [
  ...scienceNavItems,
  {
    id: "workflows",
    label: "Routines",
    description: "Create and monitor scheduled automations across your projects.",
    icon: Waypoints,
    ready: true,
    to: "/automations",
  },
  {
    id: "editor",
    label: "Editor",
    description: "Open the editor to edit a file.",
    icon: FileCode2,
    ready: true,
    to: "/quick-edit",
  },
]

export interface FeatureHelp {
  label: string
  description: string
}

/** The "What's this?" box itself; hovering inside it does not change its text. */
const FEATURE_HELP_BOX = "[data-feature-help-box]"

/** Elements the "What's this?" card describes when hovered or focused. */
export const FEATURE_HELP_CONTROLS = [
  "[data-feature-help]",
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  '[role="button"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="tab"]',
].join(",")

/**
 * True when two help texts say the same thing: equal after ignoring case, extra
 * spaces, and trailing punctuation such as "." or "…".
 */
export function sameHelpText(a: string, b: string): boolean {
  const norm = (text: string) =>
    text
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[\s.…!?:]+$/u, "")
      .trim()
  return norm(a) === norm(b)
}

function featureElement(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const match = target.closest(FEATURE_HELP_CONTROLS)
  return match instanceof HTMLElement ? match : null
}

function featureHelpFromElement(element: HTMLElement): FeatureHelp | null {
  const ariaLabel = element.getAttribute("aria-label")?.trim() ?? ""
  const title = element.getAttribute("title")?.trim() ?? ""
  const text = element.textContent?.replace(/\s+/g, " ").trim() ?? ""
  const input = element instanceof HTMLInputElement ? element.placeholder.trim() : ""
  const label = element.dataset.featureLabel?.trim() || ariaLabel || title || input || text
  if (!label) return null
  // The body is the first text that adds something to the title; empty when none does.
  const description =
    [
      element.dataset.featureHelp?.trim() ?? "",
      element.getAttribute("aria-description")?.trim() ?? "",
      title,
    ].find((text) => text !== "" && !sameHelpText(text, label)) ?? ""
  return { label, description }
}

function useFeatureHelp(active: boolean): FeatureHelp | null {
  const [help, setHelp] = useState<FeatureHelp | null>(null)

  useEffect(() => {
    if (!active) {
      setHelp(null)
      return
    }

    // Pointer and focus moves inside the help box itself keep its text, so the box keeps its
    // size and its × stays under the cursor.
    const inBox = (target: EventTarget | null) =>
      target instanceof Element && target.closest(FEATURE_HELP_BOX) !== null
    const show = (event: Event) => {
      if (inBox(event.target)) return
      const element = featureElement(event.target)
      setHelp(element ? featureHelpFromElement(element) : null)
    }
    const clear = (event: FocusEvent | PointerEvent) => {
      const current = featureElement(event.target)
      const related = featureElement(event.relatedTarget)
      if ((current && current === related) || inBox(event.relatedTarget)) return
      setHelp(related ? featureHelpFromElement(related) : null)
    }

    document.addEventListener("pointerover", show)
    document.addEventListener("pointerout", clear)
    document.addEventListener("focusin", show)
    document.addEventListener("focusout", clear)
    return () => {
      document.removeEventListener("pointerover", show)
      document.removeEventListener("pointerout", clear)
      document.removeEventListener("focusin", show)
      document.removeEventListener("focusout", clear)
    }
  }, [active])

  return help
}

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
  hidden: boolean
  x: number
  y: number
}

/**
 * Left sidebar.
 * Top to bottom: a "Dashboard" entry (carrying the divider below it), one unified
 * workspace nav (Tasks, Library, Analysis, LaTeX Editor, Skills, Routines, Cluster) rendered as a
 * single `gap-0.5` list, a divider-topped "Projects" label + the opened projects (the
 * scroll region), then a tight bottom cluster of "Add project" + Settings under a single
 * divider. Both the workspace nav and the project list are drag-reorderable within
 * themselves (`useNavOrder` / the saved project order, `useProjectReorder`); reordering never crosses between the
 * two, shows a move cursor (not a copy "+"), and marks the drop slot with a line.
 * Right-clicking a project offers "Remove from PI Lab" (removes the row only, never the
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
 * `?openProject=<abs path>` seam opens a known path once
 * on mount instead.
 *
 * The list is a bounded flex child with its own scroll (`min-h-0 overflow-y-auto`), without a nested Radix ScrollArea.
 */
export function Sidebar() {
  const t = useTranslate()
  const [language] = useInterfaceLanguage()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())
  const projectActivityStates = useProjectActivityStates()
  const projects = projectsQuery.data ?? []
  const hiddenCount =
    projectsQuery.data === undefined
      ? null
      : projects.filter((project) => Boolean(project.archivedAt)).length
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  const [width, setWidth] = useSidebarWidth()
  const [showFeatureHelp, setShowFeatureHelp] = useSidebarFeatureHelp()
  const [restoreProjectTabs] = useRestoreProjectTabs()
  const [actionError, setActionError] = useState<string | null>(null)
  const reportMutationError = (error: { message: string }) => setActionError(error.message)

  const invalidateProjects = () => {
    setActionError(null)
    return queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() })
  }

  const openProject = useMutation(
    trpc.projects.open.mutationOptions({
      onSuccess: () => void invalidateProjects(),
      onError: reportMutationError,
    }),
  )
  // Remove only the project row (the working tree on disk is never touched).
  const removeProject = useMutation(
    trpc.projects.remove.mutationOptions({
      onSuccess: () => void invalidateProjects(),
      onError: reportMutationError,
    }),
  )
  const setArchived = useMutation(
    trpc.projects.setArchived.mutationOptions({
      onSuccess: () => void invalidateProjects(),
      onError: reportMutationError,
    }),
  )
  const [projectMenu, setProjectMenu] = useState<ProjectMenuState | null>(null)
  // The project whose Edit project dialog is open (the same dialog as the Dashboard card).
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null)
  const editingProject = projects.find((project) => project.id === editingProjectId) ?? null
  const updateDetails = useMutation(
    trpc.projects.updateDetails.mutationOptions({
      onSuccess: (_project, input) => {
        setEditingProjectId(null)
        void invalidateProjects()
        void queryClient.invalidateQueries({ queryKey: trpc.projects.thumbnail.pathKey() })
        void queryClient.invalidateQueries({
          queryKey: trpc.agents.projectChoice.queryKey({ projectId: input.id }),
        })
      },
    }),
  )
  const [showHidden, setShowHidden] = useShowHiddenProjects(hiddenCount)
  const [, setWorkspaceRevision] = useState(0)

  useEffect(
    () => subscribeProjectWorkspaceState(() => setWorkspaceRevision((revision) => revision + 1)),
    [],
  )

  useOpenProjectSeam((path) => {
    void openProject.mutateAsync({ path })
  })

  // `projects.list` returns the saved project order, the one the Dashboard cards use too.
  const reorderProjects = useProjectReorder((message) => setActionError(message))
  const orderedProjects = projects.filter((project) => showHidden || !project.archivedAt)
  const projectRowProps = useDragReorder(
    orderedProjects.map((project) => project.id),
    reorderProjects,
  )

  return (
    <aside
      data-testid="app-sidebar"
      data-collapsed={collapsed}
      className={cn(
        "relative flex shrink-0 flex-col border-sidebar-border border-e bg-sidebar",
        collapsed && "w-14",
      )}
      style={collapsed ? undefined : { width }}
    >
      {/* Window top-left: the draggable title-bar region (`app-drag`). EXPANDED it
          clears the macOS traffic lights (x16,y18) and places the collapse control at
          the far-right edge. COLLAPSED, the traffic lights move into the route header
          and the expand control is centered at the top of the 56px rail. The control
          opts out of window dragging while the rest of this band remains draggable. */}
      <div
        data-testid="sidebar-titlebar"
        className={cn(
          "app-drag flex h-11 shrink-0 items-center",
          collapsed ? "justify-center px-2" : language === "ar" ? "px-2" : "pl-20 pr-2",
        )}
      >
        <CollapseToggle
          collapsed={collapsed}
          className={collapsed ? undefined : "ms-auto"}
          onToggle={() => setCollapsed(!collapsed)}
        />
      </div>

      {/* Nav body — padded; the header above is full-bleed for the traffic lights. */}
      <div data-testid="sidebar-nav-body" className="flex min-h-0 flex-1 flex-col gap-3 px-3 pb-3">
        {actionError ? (
          <p role="alert" className="cursor-text select-text text-xs text-destructive">
            {actionError}
          </p>
        ) : null}
        <ProjectDashboardNav collapsed={collapsed} />

        <WorkspaceNav collapsed={collapsed} />

        {/* The project list is the scroll region. */}
        <nav
          aria-label={t("Projects")}
          className="-me-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto border-sidebar-border border-t pe-1 pt-3"
        >
          {collapsed ? null : (
            <Link
              to="/"
              data-testid="nav-project-dashboard"
              data-feature-label={t("Projects Dashboard")}
              data-feature-help={t("Open Projects Dashboard to see every project at a glance")}
              className="rounded px-2 pb-1 font-medium text-panel-title text-xs uppercase tracking-wide transition-colors hover:text-foreground focus-visible:text-foreground"
            >
              {t("Projects")}
            </Link>
          )}
          {orderedProjects.length === 0 ? (
            collapsed ? null : (
              <p
                data-testid="projects-empty"
                className="px-1 py-2 text-muted-foreground text-xs leading-relaxed"
              >
                {t("No projects yet.")}
              </p>
            )
          ) : (
            orderedProjects.map((project) => (
              <ProjectItem
                key={project.id}
                project={project}
                collapsed={collapsed}
                workspaceState={readProjectWorkspaceState(project.id, restoreProjectTabs)}
                agentStatus={projectAgentStatus(projectActivityStates.get(project.id) ?? "idle")}
                reorder={collapsed ? null : projectRowProps(project.id)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setProjectMenu({
                    id: project.id,
                    name: project.name,
                    hidden: Boolean(project.archivedAt),
                    x: event.clientX,
                    y: event.clientY,
                  })
                }}
              />
            ))
          )}
          <ProjectVisibilityToggle
            hiddenCount={hiddenCount ?? 0}
            showHidden={showHidden}
            collapsed={collapsed}
            testId="sidebar-show-hidden-projects"
            className="mt-1"
            onToggle={() => setShowHidden(!showHidden)}
          />
        </nav>

        {!collapsed && showFeatureHelp ? (
          <FeatureHelpPanel onHide={() => setShowFeatureHelp(false)} />
        ) : null}

        {/* Bottom cluster: "Add project" then Settings, under a top divider and with a
          compact divider between the two as well (no large blank). Add project is a
          dropdown with three ways in (folder / clone / template). */}
        <div className="flex shrink-0 flex-col gap-1.5 border-sidebar-border border-t pt-3">
          <AddProjectMenu variant="sidebar" collapsed={collapsed} onAdded={invalidateProjects} />
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
        onEdit={(id) => {
          setEditingProjectId(id)
          setProjectMenu(null)
        }}
        onRemove={(id) => {
          removeProject.mutate({ id })
          setProjectMenu(null)
        }}
        onSetHidden={(id, hidden) => {
          setArchived.mutate({ id, archived: hidden })
          setProjectMenu(null)
        }}
        onDismissGitNotice={(id) => {
          dismissNonGitNotice(id)
          setProjectMenu(null)
        }}
      />

      {editingProject ? (
        <EditProjectDialog
          project={editingProject}
          mode="edit"
          pending={updateDetails.isPending}
          error={updateDetails.error?.message ?? null}
          onClose={() => setEditingProjectId(null)}
          onSave={(details) => updateDetails.mutate({ id: editingProject.id, details })}
        />
      ) : null}
    </aside>
  )
}

export function FeatureHelpPanel({ onHide }: { onHide: () => void }) {
  const help = useFeatureHelp(true)
  const t = useTranslate()
  const label = help?.label ?? t("What’s this?")
  const description = help
    ? help.description
    : t("Hover over or focus a control to learn what it does.")

  return (
    <section
      aria-label={t("Feature help")}
      data-testid="sidebar-feature-help"
      data-feature-help-box
      className="min-h-20 shrink-0 rounded-md border border-sidebar-border bg-sidebar-accent/35 p-2"
    >
      <div className="flex items-start gap-1">
        <p
          data-testid="sidebar-feature-help-label"
          className="min-w-0 flex-1 truncate font-medium text-sidebar-foreground text-xs"
        >
          {label}
        </p>
        <button
          type="button"
          aria-label={t("Hide feature help")}
          title={t("Hide feature help")}
          data-feature-help={t(
            "Hide this help panel; a compact Info button will remain to restore it",
          )}
          onClick={onHide}
          className="-me-1 -mt-1 grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      {description !== "" ? (
        <p
          data-testid="sidebar-feature-help-description"
          className="mt-1 line-clamp-3 text-[11px] text-muted-foreground leading-relaxed"
        >
          {description}
        </p>
      ) : null}
    </section>
  )
}

/**
 * The sidebar collapse/expand toggle. It always lives in the draggable sidebar header,
 * at the far right when expanded and centered in the collapsed rail. `app-no-drag`
 * preserves click handling inside that draggable region.
 */
function CollapseToggle({
  collapsed,
  className,
  onToggle,
}: {
  collapsed: boolean
  className: string | undefined
  onToggle: () => void
}) {
  const t = useTranslate()
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-testid="sidebar-collapse-toggle"
      aria-label={collapsed ? t("Expand sidebar") : t("Collapse sidebar")}
      title={collapsed ? t("Expand sidebar") : t("Collapse sidebar")}
      data-feature-help={
        collapsed
          ? t("Expand the sidebar to show navigation labels")
          : t("Collapse the sidebar to its compact icon rail")
      }
      aria-pressed={collapsed}
      className={cn("app-no-drag size-7 text-sidebar-foreground", className)}
      onClick={onToggle}
    >
      {collapsed ? <PanelLeft aria-hidden /> : <PanelLeftClose aria-hidden />}
    </Button>
  )
}

/**
 * The right-click menu for a project row, rendered once at the sidebar root and
 * positioned at the cursor: Edit project… (the Dashboard card's dialog), Dismiss Git
 * warning, Hide/Unhide, and Remove from PI Lab (`projects.remove`, the DB row only;
 * the folder on disk is left untouched).
 * Closes on outside mousedown or Escape; clicks inside (the action) don't close it
 * early thanks to the `rootRef` containment check.
 */
function ProjectContextMenu({
  menu,
  onClose,
  onEdit,
  onRemove,
  onSetHidden,
  onDismissGitNotice,
}: {
  menu: ProjectMenuState | null
  onClose: () => void
  onEdit: (id: string) => void
  onRemove: (id: string) => void
  onSetHidden: (id: string, hidden: boolean) => void
  onDismissGitNotice: (id: string) => void
}) {
  const t = useTranslate()
  const rootRef = useRef<HTMLDivElement | null>(null)

  usePopupDismiss(menu !== null, [rootRef], onClose)

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
        data-testid="project-edit"
        onClick={() => onEdit(menu.id)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent/60"
      >
        <Pencil className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{t("Edit project…")}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid="project-dismiss-git-notice"
        onClick={() => onDismissGitNotice(menu.id)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent/60"
      >
        <X className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{t("Dismiss Git warning")}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid={menu.hidden ? "project-restore" : "project-hide"}
        data-feature-label={menu.hidden ? t("Unhide project") : t("Hide project")}
        data-feature-help={
          menu.hidden
            ? t("Restore this project to the Dashboard and sidebar.")
            : t("Hide this project from the Dashboard and sidebar without removing its data.")
        }
        onClick={() => onSetHidden(menu.id, !menu.hidden)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent/60"
      >
        {menu.hidden ? (
          <Eye className="size-4 shrink-0" aria-hidden />
        ) : (
          <EyeOff className="size-4 shrink-0" aria-hidden />
        )}
        <span className="min-w-0 truncate">
          {menu.hidden ? t("Unhide project") : t("Hide project")}
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid="project-remove"
        data-feature-label={t("Remove project")}
        data-feature-help={t(
          "Remove this project from PI Lab without deleting any files from disk.",
        )}
        onClick={() => onRemove(menu.id)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-destructive text-sm transition-colors hover:bg-destructive/10"
      >
        <Trash2 className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{t("Remove from PI Lab")}</span>
      </button>
      <p className="cursor-text select-text px-2 py-1 text-[11px] text-muted-foreground leading-snug">
        {t("Removes “")}
        {menu.name}
        {t("” from the app only — the files on disk are left untouched.")}
      </p>
    </div>
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
    const direction = document.documentElement.dir === "rtl" ? -1 : 1
    const startWidth = collapsed ? COLLAPSED_RAIL_WIDTH : width
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)

    const onMove = (move: PointerEvent) => {
      const next = startWidth + direction * (move.clientX - startX)
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
      className="app-no-drag absolute inset-y-0 end-0 w-1 cursor-col-resize hover:bg-sidebar-border"
      onPointerDown={onPointerDown}
    />
  )
}

/**
 * Projects Dashboard entry — the top-of-sidebar link to the project cards ("/").
 */
function ProjectDashboardNav({ collapsed }: { collapsed: boolean }) {
  const t = useTranslate()
  const { location } = useRouterState()
  const isActive = location.pathname === "/"
  return (
    <div className="shrink-0 border-sidebar-border border-b pt-1 pb-3">
      <Link
        to="/"
        data-testid="nav-dashboard"
        data-active={isActive}
        title={collapsed ? t("Projects Dashboard") : undefined}
        data-feature-label={t("Projects Dashboard")}
        data-feature-help={t("See every open project and its current activity at a glance")}
        className={cn(navRowClass, collapsed && "justify-center", navStateClass(isActive))}
      >
        <LayoutDashboard className="size-4" aria-hidden />
        {collapsed ? null : <span className="flex-1 truncate">{t("Projects Dashboard")}</span>}
      </Link>
    </div>
  )
}

/**
 * Unified workspace nav: the
 * `scienceNavItems` registry plus Workflows and Editor, rendered as ONE `gap-0.5` list so every
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
  const t = useTranslate()
  const { location } = useRouterState()
  const pathname = location.pathname
  const [navOrder, setNavOrder] = useNavOrder()
  const [shownEntries, setEntryShown] = useShownNavEntries()
  const [entryMenu, setEntryMenu] = useState<NavEntryMenuState | null>(null)
  // A file outside every project is open in the Editor (project files open in
  // their project view instead, so only outside files reach the quick-edit state).
  const outsideFileOpen =
    useSyncExternalStore(subscribeQuickEditor, readActiveQuickTarget, readActiveQuickTarget) !==
    null
  // Hide the entries turned off in the right-click menu or in Settings > Sections
  // (Cluster and Analysis stay route-guarded too, so a bookmarked URL can't reach a
  // hidden section; the other routes stay reachable). Editor also shows while a file
  // outside every project is open.
  const isShown = (item: ScienceNavItem): boolean =>
    shownEntries.has(item.id) || (item.id === "editor" && outsideFileOpen)
  // Saved orders predate LaTeX Editor: place it below Tasks once.
  const tasksIndex = navOrder.indexOf("tasks")
  const orderWithLatex =
    navOrder.includes("latex") || tasksIndex < 0
      ? navOrder
      : [...navOrder.slice(0, tasksIndex + 1), "latex", ...navOrder.slice(tasksIndex + 1)]
  // Every entry in sidebar order (the menu's list); dragging reorders this full
  // list, so a hidden entry keeps its place for when it is shown again.
  const allOrdered = orderById(navItems, orderWithLatex.length ? orderWithLatex : DEFAULT_NAV_ORDER)
  const ordered = allOrdered.filter(isShown)
  const navRowProps = useDragReorder(
    allOrdered.map((item) => item.id),
    setNavOrder,
  )
  const openEntryMenu = (item: ScienceNavItem) => (event: React.MouseEvent) => {
    event.preventDefault()
    setEntryMenu({ id: item.id, label: item.label, x: event.clientX, y: event.clientY })
  }

  return (
    <>
      <nav
        aria-label={t("Workspace")}
        data-testid="science-nav"
        className="flex shrink-0 flex-col gap-0.5"
      >
        {ordered.map((item) => {
          const Icon = item.icon
          const testId =
            item.id === "workflows"
              ? "nav-automations"
              : item.id === "editor"
                ? "nav-editor"
                : "science-nav-item"
          const reorder = collapsed ? null : navRowProps(item.id)
          if (!item.ready || !item.to) {
            return (
              <span
                key={item.id}
                data-testid={testId}
                data-science-tab={item.id}
                data-ready={false}
                aria-disabled
                title={collapsed ? `${t(item.label)} (${t("soon")})` : undefined}
                data-feature-label={t(item.label)}
                data-feature-help={t(item.description)}
                className={cn(
                  navRowClass,
                  "text-muted-foreground/50",
                  "cursor-default",
                  collapsed && "justify-center",
                  reorder?.dropClass,
                )}
                {...reorder?.dragProps}
              >
                <Icon className="size-4" aria-hidden />
                {collapsed ? null : (
                  <>
                    <span className="flex-1 truncate">
                      <LatexText text={t(item.label)} />
                    </span>
                    <span className="text-[10px] uppercase tracking-wide">{t("soon")}</span>
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
              search={item.id === "editor" ? { target: readActiveQuickTarget()?.id } : undefined}
              data-testid={testId}
              data-science-tab={item.id}
              data-ready={true}
              data-active={isActive}
              title={collapsed ? t(item.label) : undefined}
              data-feature-label={t(item.label)}
              data-feature-help={t(item.description)}
              onContextMenu={openEntryMenu(item)}
              className={cn(
                navRowClass,
                collapsed && "justify-center",
                navStateClass(isActive),
                reorder?.dropClass,
              )}
              {...reorder?.dragProps}
            >
              <Icon className="size-4" aria-hidden />
              {collapsed ? null : (
                <span className="flex-1 truncate">
                  <LatexText text={t(item.label)} />
                </span>
              )}
            </Link>
          )
        })}
      </nav>
      <NavEntryMenu
        menu={entryMenu}
        entries={allOrdered}
        shown={shownEntries}
        onClose={() => setEntryMenu(null)}
        onSetShown={(id, shown) => {
          setEntryShown(id, shown)
          setEntryMenu(null)
        }}
      />
    </>
  )
}

/** A right-click target on a view entry of the workspace nav. */
interface NavEntryMenuState {
  id: string
  label: string
  x: number
  y: number
}

const navEntryMenuItemClass =
  "flex h-6 w-full shrink-0 items-center gap-1.5 rounded px-1.5 text-start text-foreground text-xs outline-none hover:bg-accent focus-visible:bg-accent"

/**
 * The right-click menu of the workspace nav, at the click point: "Hide '<entry>'",
 * a separator, then every view entry with a check mark on the shown ones (clicking
 * one shows or hides it). Projects Dashboard is always shown and not listed. Hiding
 * the current page's entry only removes it from the sidebar. Escape and an outside
 * click close it.
 */
function NavEntryMenu({
  menu,
  entries,
  shown,
  onClose,
  onSetShown,
}: {
  menu: NavEntryMenuState | null
  entries: ScienceNavItem[]
  shown: ReadonlySet<string>
  onClose: () => void
  onSetShown: (id: string, shown: boolean) => void
}) {
  const t = useTranslate()
  const rootRef = useRef<HTMLDivElement | null>(null)

  usePopupDismiss(menu !== null, [rootRef], onClose)

  if (!menu) return null
  return (
    <div
      ref={rootRef}
      data-testid="sidebar-view-menu"
      role="menu"
      aria-label={t("Sidebar views")}
      className="fixed z-50 flex w-48 flex-col rounded-md border border-border bg-popover p-1 text-popover-foreground text-xs shadow-lg"
      style={{ left: menu.x, top: menu.y }}
    >
      <button
        type="button"
        role="menuitem"
        data-testid="sidebar-view-menu-hide"
        onClick={() => onSetShown(menu.id, false)}
        className={navEntryMenuItemClass}
      >
        <span className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{`${t("Hide")} '${t(menu.label)}'`}</span>
      </button>
      <div className="my-1 shrink-0 border-border border-t" />
      {entries.map((entry) => {
        const isShown = shown.has(entry.id)
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={isShown}
            data-testid="sidebar-view-menu-entry"
            data-science-tab={entry.id}
            onClick={() => onSetShown(entry.id, !isShown)}
            className={navEntryMenuItemClass}
          >
            <Check className={cn("size-3 shrink-0", isShown ? "" : "invisible")} aria-hidden />
            <span className="min-w-0 truncate">{t(entry.label)}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Settings entry (also reachable via ⌘,) — the lower row of the bottom cluster. */
function SettingsNav({ collapsed }: { collapsed: boolean }) {
  const t = useTranslate()
  const { location } = useRouterState()
  const isActive = location.pathname.startsWith("/settings")
  return (
    <nav
      aria-label={t("Settings")}
      className="flex shrink-0 flex-col gap-0.5 border-sidebar-border border-t pt-2"
    >
      <Link
        to="/settings"
        data-testid="nav-settings"
        data-active={isActive}
        title={collapsed ? t("Settings") : undefined}
        data-feature-label={t("Settings")}
        data-feature-help={t(
          "Configure PI Lab appearance, agents, editor behavior, and integrations",
        )}
        onClick={() => rememberSettingsReturnRoute(location)}
        className={cn(navRowClass, collapsed && "justify-center", navStateClass(isActive))}
      >
        <Settings className="size-4" aria-hidden />
        {collapsed ? null : <span className="flex-1 truncate">{t("Settings")}</span>}
      </Link>
    </nav>
  )
}

/**
 * A single project row that links to its route and highlights when active. When
 * the sidebar is collapsed it renders an icon-sized thumbnail or first-letter badge with a
 * `title` tooltip carrying the full name; expanded it keeps that same badge beside the name and is
 * drag-reorderable via {@link reorder} (the collapsed rail passes none). Right-clicking
 * opens the remove menu via {@link onContextMenu} in either state.
 */
function ProjectItem({
  project,
  collapsed,
  workspaceState,
  agentStatus,
  reorder,
  onContextMenu,
}: {
  project: ProjectSummary
  collapsed: boolean
  workspaceState: ProjectWorkspaceState | undefined
  agentStatus: ProjectAgentStatus
  reorder?: RowReorder | null
  onContextMenu: (event: React.MouseEvent) => void
}) {
  const t = useTranslate()
  const toDisplayPath = useDisplayPath()
  const params = useParams({ strict: false }) as { projectId?: string }
  const isActive = params.projectId === project.id
  const navigate = useNavigate()
  const [sessionsExpanded, setSessionsExpanded] = useState(true)
  const agentSessions = workspaceState?.sessions.filter((session) => session.kind === "agent") ?? []
  const hasUnsavedEdits =
    workspaceState?.buffers.some(
      (buffer) => buffer.externalChange || buffer.content !== buffer.savedContent,
    ) ?? false
  // A paper added in the LaTeX Editor with no project opens there, not in a project view.
  const paperOnly = project.metadata?.paperOnly === true
  const target = paperOnly
    ? ({ to: "/science/latex", search: { projectId: project.id } } as const)
    : ({ to: "/projects/$projectId", params: { projectId: project.id } } as const)
  const openHelp = paperOnly
    ? `${t("Open ")}${project.name}${t(" in the LaTeX Editor")}`
    : `${t("Open the ")}${project.name}${t(" project workspace")}`

  if (collapsed) {
    return (
      <Link
        {...target}
        data-testid="project-item"
        data-project-id={project.id}
        data-active={isActive}
        data-hidden={Boolean(project.archivedAt)}
        onContextMenu={onContextMenu}
        className={cn(
          "flex justify-center rounded-md py-1.5 transition-colors",
          navStateClass(isActive),
          project.archivedAt && "opacity-60 saturate-50",
        )}
        title={project.name}
        data-feature-label={project.name}
        data-feature-help={openHelp}
      >
        <span className="relative">
          <ProjectBadge project={project} isActive={isActive} />
          {hasUnsavedEdits ? <UnsavedProjectMarker /> : null}
        </span>
        <span className="sr-only">{project.name}</span>
      </Link>
    )
  }

  const openSession = (id: string) => {
    if (workspaceState) {
      writeProjectWorkspaceState(project.id, { ...workspaceState, active: { type: "session", id } })
    }
    void navigate({ to: "/projects/$projectId", params: { projectId: project.id } })
  }

  return (
    <div className={reorder?.dropClass} {...reorder?.dragProps}>
      {/* The whole row opens the project; dragging needs a held button and movement. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the name link inside is the keyboard target. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the click only widens the link's target. */}
      <div
        data-testid="project-row"
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("a, button")) return
          void navigate(target)
        }}
        onContextMenu={onContextMenu}
        className={cn(
          "flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5",
          navStateClass(isActive),
        )}
      >
        <button
          type="button"
          data-testid="project-sessions-toggle"
          aria-label={`${sessionsExpanded ? t("Collapse") : t("Expand")} ${project.name} ${t("sessions")}`}
          aria-expanded={sessionsExpanded}
          title={`${sessionsExpanded ? t("Collapse") : t("Expand")} ${t("sessions")}`}
          onClick={() => setSessionsExpanded((expanded) => !expanded)}
          className="group relative size-6 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="block transition-all duration-150 group-hover:scale-75 group-hover:opacity-0">
            <ProjectBadge project={project} isActive={isActive} />
          </span>
          <ChevronDown
            className={cn(
              "absolute inset-0 m-auto size-4 transition-all duration-150",
              "scale-75 opacity-0 group-hover:scale-100 group-hover:opacity-100",
              !sessionsExpanded && "-rotate-90",
            )}
            aria-hidden
          />
        </button>
        <Link
          {...target}
          data-testid="project-item"
          data-project-id={project.id}
          data-active={isActive}
          data-hidden={Boolean(project.archivedAt)}
          className={cn(
            "min-w-0 flex-1 truncate text-start text-sm",
            project.archivedAt && "opacity-60",
          )}
          title={project.repoPath}
          data-feature-label={project.name}
          data-feature-help={
            paperOnly
              ? `${openHelp}: ${toDisplayPath(project.repoPath)}`
              : `${t("Open the ")}${project.name}${t(" project workspace at ")}${toDisplayPath(project.repoPath)}`
          }
        >
          {project.name}
        </Link>
        {hasUnsavedEdits ? <UnsavedProjectMarker /> : null}
        <ProjectAgentStatusRing status={agentStatus} />
      </div>
      {sessionsExpanded && agentSessions.length > 0 ? (
        <div data-testid="project-sessions" className="ms-6 flex flex-col gap-0.5 py-1">
          {agentSessions.map((session) => (
            <button
              type="button"
              key={session.id}
              data-testid="project-session"
              onClick={() => openSession(session.id)}
              className="flex min-w-0 items-center gap-2 rounded-md py-1 text-start text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <Bot className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{session.label}</span>
              {session.wsKind ? <KindBadge kind={session.wsKind} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** A project-level counterpart to an editor tab's dirty dot. */
function UnsavedProjectMarker() {
  const t = useTranslate()
  return (
    <span
      data-testid="project-unsaved-edits"
      role="img"
      aria-label={t("Unsaved edits")}
      title={t("Unsaved edits")}
      className="block size-2 shrink-0 rounded-full border border-muted-foreground/70 bg-transparent"
    />
  )
}

type ProjectAgentStatus = "empty" | "working" | "paused"

function projectAgentStatus(state: ProjectState): ProjectAgentStatus {
  if (state === "attention") return "paused"
  if (state === "active") return "working"
  return "empty"
}

function ProjectAgentStatusRing({ status }: { status: ProjectAgentStatus }) {
  const t = useTranslate()
  const title =
    status === "empty"
      ? t("No active agents")
      : status === "working"
        ? t("Agent working")
        : t("Agent paused")
  return (
    <span
      data-testid="project-agent-status"
      data-status={status}
      title={title}
      role="img"
      aria-label={title}
      className={cn(
        "size-2 shrink-0 rounded-full border",
        status === "empty" && "border-muted-foreground/50",
        status === "working" && "border-emerald-500 bg-emerald-500",
        status === "paused" && "border-red-500 bg-red-500",
      )}
    />
  )
}

function ProjectBadge({ project, isActive }: { project: ProjectSummary; isActive: boolean }) {
  const thumbnail = useProjectThumbnail(project, "badge")
  const badgeClassName = cn(
    "flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md text-xs font-medium uppercase",
    isActive ? "bg-accent-foreground/10" : "bg-accent",
  )

  if (thumbnail.dataUrl) {
    return (
      <span aria-hidden className={badgeClassName}>
        <img src={thumbnail.dataUrl} alt="" className="size-full object-cover" />
      </span>
    )
  }

  return (
    <span aria-hidden className={badgeClassName}>
      {project.name.trim().charAt(0) || "?"}
    </span>
  )
}

/**
 * Fire the open-project test seam exactly once on mount when `?openProject` is
 * present. A ref guard survives React 19 StrictMode's double
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
