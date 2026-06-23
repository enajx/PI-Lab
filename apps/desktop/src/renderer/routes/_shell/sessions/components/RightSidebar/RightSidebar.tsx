import { type ReactNode, useState } from "react"
import { ChangesPanel } from "./components/ChangesPanel"
import { ResearchPanel } from "./components/ResearchPanel"
import { StatusPanel } from "./components/StatusPanel"
import { TodosPanel } from "./components/TodosPanel"

/** A tab in the right sidebar: a label + the panel it reveals. */
interface PanelTab {
  id: string
  label: string
  render: (workspaceId: string) => ReactNode
}

/**
 * The right-sidebar tab set (AGENTS.md §7). Research / Status / TODOs are the v1
 * panels here; the existing Changes view is folded in so the panel set is
 * consistent. (Experiments is deferred to P8 — it needs science-state.)
 *
 * The Markdown doc panels (Research, TODOs) read plain files from the
 * workspace's working dir via `files.read`; Status/Changes read git state via
 * `workspaces.*`. Each panel owns its own data fetch, so switching tabs is just
 * a render swap.
 */
const TABS: readonly PanelTab[] = [
  { id: "research", label: "Research", render: (id) => <ResearchPanel workspaceId={id} /> },
  { id: "status", label: "Status", render: (id) => <StatusPanel workspaceId={id} /> },
  { id: "todos", label: "TODOs", render: (id) => <TodosPanel workspaceId={id} /> },
  { id: "changes", label: "Changes", render: (id) => <ChangesPanel workspaceId={id} /> },
]

/**
 * Stacked, bounded-flex sidebar: a tab strip on top, the active panel below in a
 * `min-h-0 flex-1` region so each panel's own `overflow-y-auto` body scrolls
 * (AGENTS.md §12.3 — no Radix ScrollArea).
 */
export function RightSidebar({ workspaceId }: { workspaceId: string }) {
  const [activeId, setActiveId] = useState<string>(TABS[0]?.id ?? "research")
  const active = TABS.find((tab) => tab.id === activeId) ?? TABS[0]

  return (
    <aside
      data-testid="right-sidebar"
      className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border"
    >
      <div
        role="tablist"
        aria-label="Workspace panels"
        className="flex shrink-0 items-center gap-0.5 border-border border-b p-1"
      >
        {TABS.map((tab) => {
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
              className={`flex-1 rounded-md px-2 py-1 text-xs transition-colors ${
                selected
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{active?.render(workspaceId)}</div>
    </aside>
  )
}
