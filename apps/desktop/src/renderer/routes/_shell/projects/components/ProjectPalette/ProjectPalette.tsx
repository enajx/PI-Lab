import { Bot, FileText, PanelRight, TerminalSquare } from "lucide-react"
import { useEffect, useState } from "react"
import { QuickOpen } from "../../../../../Editor/components/QuickOpen"
import { useTranslate } from "../../../../../i18n/language"
import { QuickFind, type QuickFindItem } from "../../../../../QuickFind"
import { paletteForKeydown, registerProjectPalette } from "../../../../../shortcuts/shortcuts"
import type { CentralPanelController } from "../CentralPanel"
import { type RightSidebarPanel, useRightSidebarPanels } from "../RightSidebar"

/** A palette row paired with the action it runs when chosen. */
interface PaletteAction extends QuickFindItem {
  run: () => void
}

/**
 * The project-scoped command palette (⌘P, the `project-command-palette` shortcut).
 * Mounted INSIDE the project workspace, so it's only active while a project is open
 * (never on the Dashboard / other surfaces) and has direct access to the central-panel
 * controller and the right-sidebar selection. It runs one of four action kinds:
 * open an agent, open a terminal, open a file (via the shared fuzzy {@link QuickOpen}),
 * or switch which right-sidebar panel is active.
 *
 * Reuses the generic {@link QuickFind} overlay for the action list; "Open file…" swaps
 * it for the file picker. While mounted it registers itself, so the shell's ⌘P opens this
 * palette instead of the global one. The listener is capture-phase, like the shell's, so
 * ⌘P also works while focus is in a terminal or editor.
 */
export function ProjectPalette({
  controller,
  workspaceId,
  pinnedPanels,
  gitAvailable,
  filesPanelOpen,
  onSelectPanel,
}: {
  controller: CentralPanelController
  workspaceId: string
  /** Working-dir-relative `.md` paths pinned as sidebar panels (for the switch-panel list). */
  pinnedPanels: string[]
  /** Whether Git-backed project panels are available. */
  gitAvailable?: boolean
  /** Whether this project's left Files column is open (Files then leaves the sidebar). */
  filesPanelOpen: boolean
  /** Switch (and reveal) the right-sidebar panel with this id. */
  onSelectPanel: (panelId: string) => void
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [filePickerOpen, setFilePickerOpen] = useState(false)
  const panels = useRightSidebarPanels(pinnedPanels, gitAvailable, filesPanelOpen)

  useEffect(() => {
    const unregister = registerProjectPalette()
    const onKeyDown = (event: KeyboardEvent) => {
      if (paletteForKeydown(event) === "project") {
        event.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
      unregister()
    }
  }, [])

  const actions: PaletteAction[] = [
    {
      id: "open-agent",
      label: t("Open agent"),
      icon: Bot,
      run: controller.openAgentChooser,
    },
    {
      id: "open-terminal",
      label: t("Open terminal"),
      icon: TerminalSquare,
      run: controller.openTerminal,
    },
    {
      id: "open-file",
      label: t("Open file…"),
      icon: FileText,
      run: () => setFilePickerOpen(true),
    },
    ...panels.map((panel: RightSidebarPanel) => ({
      id: `panel:${panel.id}`,
      label: `${t("Switch to")} ${t(panel.label)} ${t("panel")}`,
      icon: PanelRight,
      run: () => onSelectPanel(panel.id),
    })),
  ]

  return (
    <>
      {open ? (
        <QuickFind
          ariaLabel={t("Project command palette")}
          placeholder={t("Run a project action…")}
          items={actions}
          emptyText={t("No matching actions")}
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
