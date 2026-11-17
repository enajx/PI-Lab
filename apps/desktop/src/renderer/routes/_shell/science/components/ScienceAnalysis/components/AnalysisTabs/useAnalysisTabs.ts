import type { AddPanelPositionOptions, SerializedDockview } from "dockview-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { fileItemId } from "../../../../../projects/components/SplitDock/SplitDock"

/**
 * The open preview tabs of Analysis for one project, in the project view's
 * split dock: the files, the active one and the dock layout (splits). Saved
 * per project in `localStorage`, so they come back after a restart.
 *
 * A click in the file list replaces the active tab (the new file opens in its
 * place); a file dragged onto the dock opens as a new tab or split where it
 * is dropped; closing a tab focuses its neighbour.
 */

interface SavedTabs {
  files: string[]
  active: string | null
  layout: SerializedDockview | null
}

const storageKey = (projectId: string): string => `pi-lab.analysis.tabs.${projectId}`

function readSaved(projectId: string): SavedTabs {
  const raw = window.localStorage.getItem(storageKey(projectId))
  if (!raw) return { files: [], active: null, layout: null }
  const value = JSON.parse(raw) as Partial<SavedTabs>
  const files = Array.isArray(value.files)
    ? value.files.filter((file): file is string => typeof file === "string")
    : []
  return {
    files,
    active: typeof value.active === "string" && files.includes(value.active) ? value.active : null,
    layout: value.layout ?? null,
  }
}

export interface AnalysisTabs {
  /** The project the tabs belong to, once read (render the dock only then). */
  loadedFor: string | null
  files: string[]
  active: string | null
  /** The layout read at load, for the dock's first render. */
  initialLayout: SerializedDockview | null
  /** Show `relPath` in the active tab (a click in the list). */
  openInActiveTab: (relPath: string) => void
  /** Open `relPath` as a new tab (a drop on the dock), or focus it when open. */
  openNewTab: (relPath: string) => void
  activate: (relPath: string) => void
  close: (relPath: string) => void
  /** Close every tab whose file `keep` rejects (files that are no longer listed). */
  retain: (keep: (relPath: string) => boolean) => void
  /** A file was renamed (`to`) or deleted (`to` null): its tab follows. */
  moved: (from: string, to: string | null) => void
  onLayoutChange: (layout: SerializedDockview) => void
  /** Where a tab first appears: a replacing tab takes the replaced tab's place. */
  placementFor: (id: string) => AddPanelPositionOptions | undefined
}

export function useAnalysisTabs(
  projectId: string | null,
  initialFile: string | null,
): AnalysisTabs {
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [initialLayout, setInitialLayout] = useState<SerializedDockview | null>(null)
  const layout = useRef<SerializedDockview | null>(null)
  /** The tab a click is replacing; removed once its replacement is in the dock. */
  const replacing = useRef<{ old: string; next: string } | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again only for another project.
  useEffect(() => {
    if (!projectId) return
    const saved = readSaved(projectId)
    const withInitial =
      initialFile && !saved.files.includes(initialFile)
        ? [...saved.files, initialFile]
        : saved.files
    setFiles(withInitial)
    setActive(initialFile ?? saved.active ?? withInitial[0] ?? null)
    setInitialLayout(saved.layout)
    layout.current = saved.layout
    replacing.current = null
    setLoadedFor(projectId)
  }, [projectId])

  // "Open in Analysis" while Analysis is already showing this project.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the address names a file.
  useEffect(() => {
    if (initialFile && loadedFor === projectId) openNewTabRef.current(initialFile)
  }, [initialFile])

  // Saved whenever the tabs change, once they belong to the shown project.
  useEffect(() => {
    if (!projectId || loadedFor !== projectId) return
    const value: SavedTabs = { files, active, layout: layout.current }
    window.localStorage.setItem(storageKey(projectId), JSON.stringify(value))
  }, [active, files, loadedFor, projectId])

  // The replaced tab closes once its replacement is open (the dock places it first).
  useEffect(() => {
    const pending = replacing.current
    if (!pending || !files.includes(pending.next)) return
    replacing.current = null
    setFiles((current) => current.filter((file) => file !== pending.old))
  }, [files])

  const openNewTab = useCallback((relPath: string) => {
    setFiles((current) => (current.includes(relPath) ? current : [...current, relPath]))
    setActive(relPath)
  }, [])
  const openNewTabRef = useRef(openNewTab)
  openNewTabRef.current = openNewTab

  const openInActiveTab = (relPath: string): void => {
    if (files.includes(relPath)) {
      setActive(relPath)
      return
    }
    if (active && files.includes(active)) {
      replacing.current = { old: active, next: relPath }
      const at = files.indexOf(active)
      setFiles([...files.slice(0, at + 1), relPath, ...files.slice(at + 1)])
    } else setFiles([...files, relPath])
    setActive(relPath)
  }

  const close = (relPath: string): void => {
    const at = files.indexOf(relPath)
    const rest = files.filter((file) => file !== relPath)
    setFiles(rest)
    if (active === relPath) setActive(rest[Math.min(at, rest.length - 1)] ?? null)
  }

  const retain = (keep: (relPath: string) => boolean): void => {
    if (files.every(keep)) return
    const rest = files.filter(keep)
    setFiles(rest)
    if (active && !rest.includes(active)) setActive(rest[0] ?? null)
  }

  const moved = (from: string, to: string | null): void => {
    if (to === null) close(from)
    else {
      setFiles(files.map((file) => (file === from ? to : file)))
      if (active === from) setActive(to)
    }
  }

  return {
    loadedFor,
    files,
    active,
    initialLayout,
    openInActiveTab,
    openNewTab,
    activate: setActive,
    close,
    retain,
    moved,
    onLayoutChange: (next) => {
      layout.current = next
      if (projectId && loadedFor === projectId) {
        window.localStorage.setItem(
          storageKey(projectId),
          JSON.stringify({ files, active, layout: next } satisfies SavedTabs),
        )
      }
    },
    placementFor: (id) => {
      const pending = replacing.current
      return pending && id === fileItemId(pending.next)
        ? { referencePanel: fileItemId(pending.old), direction: "within" }
        : undefined
    },
  }
}
