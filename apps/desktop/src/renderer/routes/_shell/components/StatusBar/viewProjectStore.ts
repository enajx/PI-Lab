import { useEffect, useSyncExternalStore } from "react"

/** The view that reported the current project, so an older view's unmount cannot clear a newer one's. */
let owner: object | null = null
let current: string | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/**
 * Report the project the mounted view has selected (the project view, or a
 * science tab's project picker), or null for none (e.g. "All projects"). The
 * window status bar shows it. The report is dropped when the view unmounts.
 */
export function useReportViewProject(projectId: string | null): void {
  useEffect(() => {
    const me = {}
    owner = me
    current = projectId
    notify()
    return () => {
      if (owner !== me) return
      owner = null
      current = null
      notify()
    }
  }, [projectId])
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The project the current view has selected, or null. */
export function useViewProject(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )
}
