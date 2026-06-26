import { cn } from "@skipper/ui"
import { Check, PanelRightClose, Settings2 } from "lucide-react"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { useShowCodeChanges, useShowFilesPanel } from "../../../../../preferences/preferences"
import { ChangesPanel } from "./components/ChangesPanel"
import { FilesPanel } from "./components/FilesPanel"
import { ResearchPanel } from "./components/ResearchPanel"
import { TodosPanel } from "./components/TodosPanel"

/** A tab in the right sidebar: a label + the panel it reveals. */
interface PanelTab {
  id: string
  label: string
  render: (workspaceId: string, onOpenFile: (relPath: string) => void) => ReactNode
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
  { id: "research", label: "Research", render: (id) => <ResearchPanel workspaceId={id} /> },
  { id: "todos", label: "TODOs", render: (id) => <TodosPanel workspaceId={id} /> },
]

const FILES_TAB: PanelTab = {
  id: "files",
  label: "Files",
  render: (id, onOpenFile) => <FilesPanel workspaceId={id} onOpenFile={onOpenFile} />,
}

const CODE_CHANGES_TAB: PanelTab = {
  id: "changes",
  label: "Code changes",
  render: (id) => <ChangesPanel workspaceId={id} />,
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
  workspaceId,
  onOpenFile,
  onCollapse,
}: {
  workspaceId: string
  onOpenFile: (relPath: string) => void
  onCollapse: () => void
}) {
  const [showCodeChanges, setShowCodeChanges] = useShowCodeChanges()
  const [showFilesPanel] = useShowFilesPanel()
  // Files moves to the left central column when the left Files panel is on, so
  // drop its tab here in that case.
  const tabs = [
    ...BASE_TABS,
    ...(showFilesPanel ? [] : [FILES_TAB]),
    ...(showCodeChanges ? [CODE_CHANGES_TAB] : []),
  ]
  const [activeId, setActiveId] = useState<string>(BASE_TABS[0]?.id ?? "research")
  // The selected tab can vanish (Files toggled to the left, Code changes hidden),
  // so fall back to the first tab whenever the stored id no longer resolves.
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]

  return (
    <aside
      data-testid="right-sidebar"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border"
    >
      <div className="flex shrink-0 items-center gap-0.5 border-border border-b p-1">
        <div role="tablist" aria-label="Project panels" className="flex min-w-0 flex-1 gap-0.5">
          {tabs.map((tab) => {
            const selected = tab.id === active?.id
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-testid={`panel-tab-${tab.id}`}
                data-active={selected}
                onClick={() => setActiveId(tab.id)}
                className={cn(
                  "flex-1 rounded-md px-2 py-1 text-xs transition-colors",
                  selected
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
        <ViewOptionsMenu
          showCodeChanges={showCodeChanges}
          onToggleCodeChanges={() => setShowCodeChanges(!showCodeChanges)}
        />
        <button
          type="button"
          data-testid="right-sidebar-collapse"
          aria-label="Collapse panel"
          title="Collapse panel"
          onClick={onCollapse}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelRightClose className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{active?.render(workspaceId, onOpenFile)}</div>
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
  onToggleCodeChanges,
}: {
  showCodeChanges: boolean
  onToggleCodeChanges: () => void
}) {
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
        aria-label="View options"
        title="View options"
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
          className="absolute top-8 right-0 z-50 w-56 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
        >
          <p id={labelId} className="px-2 py-1 font-medium text-muted-foreground text-xs">
            View options
          </p>
          <ToggleRow
            testId="right-sidebar-toggle-changes"
            label="Code changes"
            description="Show the git working-tree diff panel"
            checked={showCodeChanges}
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
  onToggle: () => void
}

/** A single on/off view-option row with a checkbox-style affordance. */
function ToggleRow({ testId, label, description, checked, onToggle }: ToggleRowProps) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      data-testid={testId}
      data-checked={checked}
      onClick={onToggle}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
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
        <span className="block text-foreground text-xs">{label}</span>
        <span className="block text-muted-foreground text-[11px]">{description}</span>
      </span>
    </button>
  )
}
