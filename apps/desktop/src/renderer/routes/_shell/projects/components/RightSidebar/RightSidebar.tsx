import { cn } from "@pi-lab/ui"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Check, PanelRightClose, Pin, Settings2, X } from "lucide-react"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { QuickOpen } from "../../../../../Editor/components/QuickOpen"
import { useTranslate } from "../../../../../i18n/language"
import {
  useShowCodeChanges,
  useShowFilesPanel,
  useShowSkillsPanel,
} from "../../../../../preferences/preferences"
import { useTRPC } from "../../../../../trpc/react"
import { ChangesPanel } from "./components/ChangesPanel"
import { DocPanel } from "./components/DocPanel"
import { FilesPanel } from "./components/FilesPanel"
import { ResearchPanel } from "./components/ResearchPanel"
import { SkillsPanel } from "./components/SkillsPanel"
import { TodosPanel } from "./components/TodosPanel"

interface PanelRenderContext {
  projectId: string
  workspaceId: string
  onOpenFile: (relPath: string) => void
  activeRelPath: string | null
  /** Pin a `.md` file as a right-sidebar panel (from the Files tree's right-click menu). */
  onPinFile: (relPath: string) => void
  onSetMainFile: (relPath: string) => void
}

/** Tab-id prefix marking a user-pinned Markdown panel (the rest is its relPath). */
const PINNED_PREFIX = "pinned:"

/** The relPath of a pinned tab, or `null` for a built-in tab. */
function pinnedRelPath(tabId: string): string | null {
  return tabId.startsWith(PINNED_PREFIX) ? tabId.slice(PINNED_PREFIX.length) : null
}

function basename(relPath: string): string {
  return relPath.split("/").pop() ?? relPath
}

/** A tab in the right sidebar: a label + the panel it reveals. */
interface PanelTab {
  id: string
  label: string
  description: string
  render: (context: PanelRenderContext) => ReactNode
}

/**
 * The right-sidebar tab set for the project view. **Research / TODOs / Files** are
 * the default panels; **Code changes** (the git working-tree diff) is hidden by
 * default and toggled on via the gear (persisted in `projectView.showCodeChanges`,
 * also editable in Settings → Project view). The old Status panel was dropped — its
 * content (status header + branch) already lives in Research and the agent tab's
 * kind badge. When the left Files panel is enabled (`projectView.showFilesPanel`,
 * owned by the central panel), Files lives on the left instead, so it's excluded
 * from this tab set.
 *
 * Markdown doc panels (Research, TODOs) read plain files via `files.read`; Files
 * is the workspace tree (opening a file into the central panel); Code changes
 * reads git state via `workspaces.changes`. Each panel owns its own data fetch,
 * so switching tabs is just a render swap.
 */
const BASE_TABS: readonly PanelTab[] = [
  {
    id: "research",
    label: "Research",
    description:
      "Read the project's selected main Markdown file, where durable context and findings are kept.",
    render: ({ projectId, workspaceId }) => (
      <ResearchPanel projectId={projectId} workspaceId={workspaceId} />
    ),
  },
  {
    id: "todos",
    label: "TODOs",
    description: "View the project's selected task Markdown file.",
    render: ({ projectId, workspaceId }) => (
      <TodosPanel projectId={projectId} workspaceId={workspaceId} />
    ),
  },
]

const FILES_TAB: PanelTab = {
  id: "files",
  label: "Files",
  description: "Browse workspace files and open them in the built-in editor.",
  render: ({ workspaceId, onOpenFile, activeRelPath, onPinFile, onSetMainFile }) => (
    <FilesPanel
      workspaceId={workspaceId}
      onOpenFile={onOpenFile}
      activeRelPath={activeRelPath}
      onPinFile={onPinFile}
      onSetMainFile={onSetMainFile}
    />
  ),
}

/** Build a right-sidebar tab that renders one pinned `.md` file through the shared DocPanel. */
function pinnedTab(relPath: string): PanelTab {
  const name = basename(relPath)
  return {
    id: `${PINNED_PREFIX}${relPath}`,
    label: name,
    description: `Pinned Markdown panel showing ${relPath}.`,
    render: ({ workspaceId }) => <PinnedDocPanel workspaceId={workspaceId} relPath={relPath} />,
  }
}

function PinnedDocPanel({ workspaceId, relPath }: { workspaceId: string; relPath: string }) {
  const t = useTranslate()
  return (
    <DocPanel
      workspaceId={workspaceId}
      relPath={relPath}
      testId={`panel-pinned:${relPath}`}
      emptyTitle={`${basename(relPath)} ${t("is empty")}`}
      emptyHint={
        <>
          {t("This pinned file (")}
          <code className="font-mono">{relPath}</code>
          {t(") has no content yet.")}
        </>
      }
    />
  )
}

const CODE_CHANGES_TAB: PanelTab = {
  id: "changes",
  label: "Code changes",
  description: "Review staged, unstaged, and untracked Git changes in this workspace.",
  render: ({ workspaceId }) => <ChangesPanel workspaceId={workspaceId} />,
}

const SKILLS_TAB: PanelTab = {
  id: "skills",
  label: "Skills",
  description: "Browse this project's local skills followed by your global skills.",
  render: ({ projectId }) => <SkillsPanel projectId={projectId} />,
}

/**
 * The right-sidebar tab set, in display order, for the current view options and
 * pinned panels. The single source of truth shared by the sidebar itself and the
 * project command palette's "switch panel" list (via {@link useRightSidebarPanels}),
 * so the two never drift out of sync. Files moves to the left central column when
 * the left Files panel is on; Skills / Code changes are opt-in; pinned panels last.
 */
function buildPanelTabs(options: {
  showFilesPanel: boolean
  showSkills: boolean
  showCodeChanges: boolean
  gitAvailable: boolean
  pinnedPanels: string[]
}): PanelTab[] {
  return [
    ...BASE_TABS,
    ...(options.showFilesPanel ? [] : [FILES_TAB]),
    ...(options.showSkills ? [SKILLS_TAB] : []),
    ...(options.showCodeChanges && options.gitAvailable ? [CODE_CHANGES_TAB] : []),
    ...options.pinnedPanels.map(pinnedTab),
  ]
}

/** A right-sidebar panel's identity, for the project palette's "switch panel" list. */
export interface RightSidebarPanel {
  id: string
  label: string
}

/**
 * The right-sidebar panels currently shown, in tab order — the same list the
 * {@link RightSidebar} renders, reduced to `{ id, label }`. Reads the same view-option
 * preferences the sidebar does, so switching a panel from the project command palette
 * always targets a tab that actually exists.
 */
export function useRightSidebarPanels(
  pinnedPanels: string[],
  gitAvailable?: boolean,
): RightSidebarPanel[] {
  const t = useTranslate()
  const [showCodeChanges] = useShowCodeChanges()
  const [showSkills] = useShowSkillsPanel()
  const [showFilesPanel] = useShowFilesPanel()
  return buildPanelTabs({
    showFilesPanel,
    showSkills,
    showCodeChanges,
    gitAvailable: gitAvailable !== false,
    pinnedPanels,
  }).map((tab) => ({ id: tab.id, label: pinnedRelPath(tab.id) ? tab.label : t(tab.label) }))
}

/**
 * Stacked, bounded-flex sidebar: a tab strip on top (plus a collapse button and a
 * gear opening a view-options menu), the active panel below in a `min-h-0 flex-1`
 * region so each panel's own `overflow-y-auto` body scrolls (AGENTS.md Pitfalls #3
 * — no Radix ScrollArea). The collapse button calls `onCollapse`; the project route
 * owns the collapse state (session state, defaulting to EXPANDED on each project open —
 * not persisted), dropping the right column and showing an expand affordance when collapsed.
 */
export function RightSidebar({
  projectId,
  workspaceId,
  onOpenFile,
  activeRelPath = null,
  activeId: controlledActiveId,
  initialActiveId,
  onActiveIdChange,
  onCollapse,
  pinnedPanels = [],
  onPinFile,
  onUnpinFile,
  gitAvailable,
}: {
  projectId: string
  workspaceId: string
  onOpenFile: (relPath: string) => void
  activeRelPath?: string | null
  /** Controlled selected-tab id: when provided, the route drives selection (e.g. the
   * project command palette's "switch panel"). `null`/an unknown id falls back to the
   * first tab. Mutually exclusive with the uncontrolled `initialActiveId` seed. */
  activeId?: string | null
  initialActiveId?: string
  onActiveIdChange?: (id: string) => void
  onCollapse: () => void
  /** Working-dir-relative `.md` paths pinned as persistent panels (owned by the route). */
  pinnedPanels?: string[]
  /** Pin a `.md` file as a panel. */
  onPinFile?: (relPath: string) => void
  /** Remove a pinned panel. */
  onUnpinFile?: (relPath: string) => void
  /** Whether this project's folder has Git features available. */
  gitAvailable?: boolean
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const setMain = useMutation(
    trpc.projects.setDocumentPath.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.projects.get.queryKey() })
        void queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() })
      },
    }),
  )
  const [showCodeChanges, setShowCodeChanges] = useShowCodeChanges()
  const [showSkills, setShowSkills] = useShowSkillsPanel()
  const [showFilesPanel] = useShowFilesPanel()
  const [pinPickerOpen, setPinPickerOpen] = useState(false)
  const gitEnabled = gitAvailable !== false
  const tabs = buildPanelTabs({
    showFilesPanel,
    showSkills,
    showCodeChanges,
    gitAvailable: gitEnabled,
    pinnedPanels,
  })
  // Selection is controlled when the route passes `activeId` (so the palette can switch
  // panels reactively); otherwise the sidebar owns it internally, seeded once from
  // `initialActiveId`. `onActiveIdChange` still fires in both modes for persistence.
  const controlled = controlledActiveId !== undefined
  const [uncontrolledActiveId, setUncontrolledActiveId] = useState<string>(
    initialActiveId ?? BASE_TABS[0]?.id ?? "research",
  )
  const activeId = controlled ? (controlledActiveId ?? "") : uncontrolledActiveId
  const selectTab = (id: string) => {
    if (!controlled) setUncontrolledActiveId(id)
    onActiveIdChange?.(id)
  }
  // The selected tab can vanish (Files toggled to the left, Code changes hidden, a
  // pinned panel unpinned) or be unset in controlled mode, so fall back to the first
  // tab whenever the stored id no longer resolves.
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]

  // Pinning is a no-op unless the route wired a handler; guard so the "+" picker and
  // the Files tree's right-click menu never silently drop a selection.
  const pinFile = (relPath: string) => onPinFile?.(relPath)

  return (
    <aside
      data-testid="right-sidebar"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border"
    >
      <div className="flex shrink-0 items-center gap-0.5 border-border border-b p-1">
        <div
          role="tablist"
          aria-label={t("Project panels")}
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          {tabs.map((tab) => {
            const selected = tab.id === active?.id
            const relPath = pinnedRelPath(tab.id)
            const tabButton = (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-testid={`panel-tab-${tab.id}`}
                data-active={selected}
                data-feature-label={pinnedRelPath(tab.id) ? tab.label : t(tab.label)}
                data-feature-help={
                  relPath ? `${t("Pinned Markdown panel showing ")}${relPath}.` : t(tab.description)
                }
                title={relPath ?? undefined}
                onClick={() => selectTab(tab.id)}
                className={cn(
                  "min-w-0 flex-1 truncate rounded-md px-2 py-1 text-xs transition-colors",
                  selected
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {relPath ? tab.label : t(tab.label)}
              </button>
            )
            if (relPath === null) return tabButton
            // Pinned tabs carry an inline unpin affordance (built-in tabs can't be removed).
            return (
              <span key={tab.id} className="flex min-w-0 flex-1 items-center">
                {tabButton}
                <button
                  type="button"
                  data-testid={`right-sidebar-unpin:${relPath}`}
                  aria-label={`${t("Unpin ")}${tab.label}`}
                  title={t("Unpin panel")}
                  data-feature-help={t("Remove this pinned Markdown panel from the sidebar")}
                  onClick={() => onUnpinFile?.(relPath)}
                  className="-ml-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            )
          })}
        </div>
        <button
          type="button"
          data-testid="right-sidebar-pin"
          aria-label={t("Pin a Markdown panel")}
          title={t("Pin a Markdown panel")}
          data-feature-help={t(
            "Pin a Markdown file as a persistent panel in this project's sidebar",
          )}
          onClick={() => setPinPickerOpen(true)}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Pin className="size-3.5" aria-hidden />
        </button>
        <ViewOptionsMenu
          showCodeChanges={showCodeChanges}
          showSkills={showSkills}
          gitAvailable={gitEnabled}
          onToggleCodeChanges={() => setShowCodeChanges(!showCodeChanges)}
          onToggleSkills={() => setShowSkills(!showSkills)}
        />
        <button
          type="button"
          data-testid="right-sidebar-collapse"
          aria-label={t("Collapse panel")}
          title={t("Collapse panel")}
          data-feature-help={t("Hide the project details sidebar to give the editor more room")}
          onClick={onCollapse}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelRightClose className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {setMain.error ? (
          <p role="alert" className="px-4 py-2 text-destructive text-xs">
            {setMain.error.message}
          </p>
        ) : null}
        {active?.render({
          projectId,
          workspaceId,
          onOpenFile,
          activeRelPath,
          onPinFile: pinFile,
          onSetMainFile: (relPath) => setMain.mutate({ id: projectId, kind: "main", relPath }),
        })}
      </div>
      {pinPickerOpen ? (
        <QuickOpen
          workspaceId={workspaceId}
          filter={(relPath) => relPath.endsWith(".md")}
          onOpenFile={(relPath) => {
            pinFile(relPath)
            setPinPickerOpen(false)
          }}
          onClose={() => setPinPickerOpen(false)}
        />
      ) : null}
    </aside>
  )
}

/**
 * Gear-button popover listing the sidebar's toggleable view options (mirrors the
 * editor's settings menu: `aria-haspopup="menu"` trigger + an absolutely
 * positioned `role="menu"` that closes on outside mousedown or Escape). Today it
 * holds a single item — the Code changes panel — but it's shaped to grow.
 */
function ViewOptionsMenu({
  showCodeChanges,
  showSkills,
  gitAvailable,
  onToggleCodeChanges,
  onToggleSkills,
}: {
  showCodeChanges: boolean
  showSkills: boolean
  gitAvailable: boolean
  onToggleCodeChanges: () => void
  onToggleSkills: () => void
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const labelId = useId()

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

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="right-sidebar-settings"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("View options")}
        title={t("View options")}
        data-feature-help={t("Choose which optional panels appear in the project sidebar")}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground",
          open ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <Settings2 className="size-3.5" aria-hidden />
      </button>

      {open ? (
        <div
          data-testid="right-sidebar-settings-menu"
          role="menu"
          aria-labelledby={labelId}
          className="absolute top-8 end-0 z-50 w-56 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
        >
          <p id={labelId} className="px-2 py-1 font-medium text-muted-foreground text-xs">
            {t("View options")}
          </p>
          <ToggleRow
            testId="right-sidebar-toggle-skills"
            label="Skills"
            description="Show project-local and global skills"
            checked={showSkills}
            onToggle={onToggleSkills}
          />
          <ToggleRow
            testId="right-sidebar-toggle-changes"
            label="Code changes"
            description={
              gitAvailable
                ? "Show the git working-tree diff panel"
                : "Initialize Git to review Code changes."
            }
            checked={showCodeChanges}
            disabled={!gitAvailable}
            onToggle={onToggleCodeChanges}
          />
        </div>
      ) : null}
    </div>
  )
}

interface ToggleRowProps {
  testId: string
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onToggle: () => void
}

/** A single on/off view-option row with a checkbox-style affordance. */
function ToggleRow({ testId, label, description, checked, disabled, onToggle }: ToggleRowProps) {
  const t = useTranslate()
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
      data-testid={testId}
      data-checked={checked}
      data-feature-label={t(label)}
      data-feature-help={t(description)}
      onClick={onToggle}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
          checked ? "border-primary bg-primary text-primary-foreground" : "border-border",
        )}
      >
        {checked ? <Check className="size-3" aria-hidden /> : null}
      </span>
      <span className="min-w-0">
        <span className="block text-foreground text-xs">{t(label)}</span>
        <span className="block text-muted-foreground text-[11px]">{t(description)}</span>
      </span>
    </button>
  )
}
