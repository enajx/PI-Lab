import { useCallback, useSyncExternalStore } from "react"

export interface PendingOpenFile {
  token: number
  kind: "file" | "new"
  relPath?: string
}

const pendingByProject = new Map<string, PendingOpenFile>()
const listenersByProject = new Map<string, Set<() => void>>()
let nextToken = 0

function emit(projectId: string): void {
  const listeners = listenersByProject.get(projectId)
  if (listeners) for (const listener of listeners) listener()
}

function subscribe(projectId: string, listener: () => void): () => void {
  let listeners = listenersByProject.get(projectId)
  if (!listeners) {
    listeners = new Set()
    listenersByProject.set(projectId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners?.delete(listener)
    if (listeners?.size === 0) listenersByProject.delete(projectId)
  }
}

/**
 * Carry one just-created file across a project transition, or notify an already
 * mounted view when the chosen project is the current route.
 */
export function setPendingOpenFile(projectId: string, relPath: string): void {
  nextToken += 1
  pendingByProject.set(projectId, { token: nextToken, kind: "file", relPath })
  emit(projectId)
}

/** Ask a mounted or destination project workspace to open an untitled editor buffer. */
export function setPendingNewFile(projectId: string): void {
  nextToken += 1
  pendingByProject.set(projectId, { token: nextToken, kind: "new" })
  emit(projectId)
}

/** Read without consuming so React StrictMode's repeated initial render is safe. */
export function readPendingOpenFile(projectId: string): PendingOpenFile | null {
  return pendingByProject.get(projectId) ?? null
}

/** Subscribe to both pre-navigation and same-route file-open requests. */
export function usePendingOpenFile(projectId: string): PendingOpenFile | null {
  const subscribeToProject = useCallback(
    (listener: () => void) => subscribe(projectId, listener),
    [projectId],
  )
  const getSnapshot = useCallback(() => readPendingOpenFile(projectId), [projectId])
  return useSyncExternalStore(subscribeToProject, getSnapshot, () => null)
}

/** Clear only the request handed to the editor, preserving any newer request. */
export function clearPendingOpenFile(projectId: string, token?: number): void {
  const current = pendingByProject.get(projectId)
  if (!current || (token !== undefined && current.token !== token)) return
  pendingByProject.delete(projectId)
  emit(projectId)
}
