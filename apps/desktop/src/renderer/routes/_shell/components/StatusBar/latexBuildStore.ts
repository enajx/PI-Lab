import { useSyncExternalStore } from "react"

/** What the window status bar shows of a workspace's LaTeX builds. */
export interface LatexBuildSummary {
  state: "building" | "complete" | "failed"
  /** The editor footer's status text, e.g. "Building LaTeX…". */
  message: string
}

/** The last summary of each mounted workspace, with the order it was published in. */
const builds = new Map<string, { summary: LatexBuildSummary; order: number }>()
const listeners = new Set<() => void>()
let order = 0
let latest: LatexBuildSummary | null = null

/**
 * Record the LaTeX build state of `workspaceId` (from `useLatexBuild`), or
 * forget it with null when its editor unmounts. The status bar shows the most
 * recently published one.
 */
export function publishLatexBuild(workspaceId: string, summary: LatexBuildSummary | null): void {
  if (summary === null) builds.delete(workspaceId)
  else builds.set(workspaceId, { summary, order: ++order })
  let newest: { summary: LatexBuildSummary; order: number } | null = null
  for (const entry of builds.values())
    if (newest === null || entry.order > newest.order) newest = entry
  latest = newest?.summary ?? null
  for (const notify of listeners) notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The most recently published LaTeX build state of a mounted editor, or null. */
export function useLatestLatexBuild(): LatexBuildSummary | null {
  return useSyncExternalStore(
    subscribe,
    () => latest,
    () => null,
  )
}
