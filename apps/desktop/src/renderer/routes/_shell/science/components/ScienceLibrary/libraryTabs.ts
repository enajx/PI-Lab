import { useState } from "react"

/**
 * One Library viewer tab: a library item's local file (resolved again by `itemId` when shown)
 * or a web URL for an item with no local copy.
 */
export type ViewerTab =
  | { type: "file"; id: string; itemId: string; title: string }
  | { type: "url"; id: string; url: string; title: string }

interface StoredTabs {
  /** The library source the tabs belong to (tabs of another source are not shown). */
  source: string
  tabs: ViewerTab[]
  activeId: string | null
}

const STORAGE_KEY = "pi-lab.library.viewerTabs"

function readStored(source: string): StoredTabs {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  const stored = raw ? (JSON.parse(raw) as StoredTabs) : null
  return stored?.source === source ? stored : { source, tabs: [], activeId: null }
}

/**
 * The Library viewer's open tabs and active tab for one library source, saved in
 * `localStorage` so they come back after leaving the Library or restarting the app.
 * Opening a tab that is already open switches to it.
 */
export function useLibraryTabs(source: string): {
  tabs: ViewerTab[]
  activeId: string | null
  open: (tab: ViewerTab) => void
  close: (id: string) => void
  activate: (id: string) => void
} {
  const [state, setState] = useState<StoredTabs>(() => readStored(source))
  const current = state.source === source ? state : readStored(source)
  if (current !== state) setState(current)

  const update = (next: StoredTabs) => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    setState(next)
  }
  return {
    tabs: current.tabs,
    activeId: current.activeId,
    open: (tab) =>
      update({
        ...current,
        tabs: current.tabs.some((t) => t.id === tab.id) ? current.tabs : [...current.tabs, tab],
        activeId: tab.id,
      }),
    close: (id) => {
      const index = current.tabs.findIndex((t) => t.id === id)
      const tabs = current.tabs.filter((t) => t.id !== id)
      const activeId =
        current.activeId === id
          ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
          : current.activeId
      update({ ...current, tabs, activeId })
    },
    activate: (id) => update({ ...current, activeId: id }),
  }
}
