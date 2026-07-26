import { Bot, FileText, PanelRight, TerminalSquare } from "lucide-react"
import { useEffect, useState } from "react"
import { QuickOpen } from "../../../../../Editor/components/QuickOpen"
import { QuickFind, type QuickFindItem } from "../../../../../QuickFind"
import { eventMatchesShortcut } from "../../../../../shortcuts/shortcuts"
import type { CentralPanelController } from "../CentralPanel"
import { type RightSidebarPanel, useRightSidebarPanels } from "../RightSidebar"

/** A palette row paired with the action it runs when chosen. */
interface PaletteAction extends QuickFindItem {
  run: () => void
}

/**
 * The project-scoped command palette (⇧⌘P, the `project-command-palette` shortcut).
 * Mounted INSIDE the project workspace, so it's only active while a project is open
 * (never on the Dashboard / other surfaces) and has direct access to the central-panel
 * controller and the right-sidebar selection. It runs one of four action kinds:
 * open an agent, open a terminal, open a file (via the shared fuzzy {@link QuickOpen}),
 * or switch which right-sidebar panel is active.
 *
 * Reuses the generic {@link QuickFind} overlay for the action list; "Open file…" swaps
 * it for the file picker. The listener is bubble-phase (like the project view's ⌘F
 * quick-open), so a terminal/editor that swallows its own keys keeps focus.
 */
export function ProjectPalette({
  controller,
  workspaceId,
  pinnedPanels,
  gitAvailable,
  onSelectPanel,
}: {
  controller: CentralPanelController
  workspaceId: string
  /** Working-dir-relative `.md` paths pinned as sidebar panels (for the switch-panel list). */
  pinnedPanels: string[]
  /** Whether Git-backed project panels are available. */
  gitAvailable?: boolean
  /** Switch (and reveal) the right-sidebar panel with this id. */
  onSelectPanel: (panelId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [filePickerOpen, setFilePickerOpen] = useState(false)
  const panels = useRightSidebarPanels(pinnedPanels, gitAvailable)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (eventMatchesShortcut(event, "project-command-palette")) {
        event.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const actions: PaletteAction[] = [
    {
      id: "open-agent",
      label: "Open agent",
      icon: Bot,
      run: controller.openAgentChooser,
    },
    {
      id: "open-terminal",
      label: "Open terminal",
      icon: TerminalSquare,
      run: controller.openTerminal,
    },
    {
      id: "open-file",
      label: "Open file…",
      icon: FileText,
      run: () => setFilePickerOpen(true),
    },
    ...panels.map((panel: RightSidebarPanel) => ({
      id: `panel:${panel.id}`,
      label: `Switch to ${panel.label} panel`,
      icon: PanelRight,
      run: () => onSelectPanel(panel.id),
    })),
  ]

  return (
    <>
      {open ? (
        <QuickFind
          ariaLabel="Project command palette"
          placeholder="Run a project action…"
          items={actions}
          emptyText="No matching actions"
          onSelect={(item) => actions.find((action) => action.id === item.id)?.run()}
          onClose={() => setOpen(false)}
        />
      ) : null}
      {filePickerOpen ? (
        <QuickOpen
          workspaceId={workspaceId}
          onOpenFile={(relPath) => {
            controller.openFile(relPath)
            setFilePickerOpen(false)
          }}
          onClose={() => setFilePickerOpen(false)}
        />
      ) : null}
    </>
  )
}
