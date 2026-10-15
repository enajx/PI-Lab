import type { FileStat } from "@pi-lab/workspace-fs"
import type { QuickEditTarget } from "../../shared/quickEdit"

/** Live quick-edit draft retained while navigating around the full app. */
export interface QuickBuffer {
  target: QuickEditTarget
  content: string
  savedContent: string
  baseline: FileStat
  epoch: number
  conflict: boolean
}

const buffers = new Map<string, QuickBuffer>()
const listeners = new Set<() => void>()
let activeTarget: QuickEditTarget | null = null
let revision = 0

function emit(): void {
  revision += 1
  for (const listener of listeners) listener()
}

/** Read the latest buffer, including edits made before a route change. */
export function readQuickBuffer(id: string): QuickBuffer | null {
  return buffers.get(id) ?? null
}

/** Store a draft before React batches its render update. */
export function writeQuickBuffer(buffer: QuickBuffer): void {
  buffers.set(buffer.target.id, buffer)
  activeTarget = buffer.target
  emit()
}

/** Remove a closed file so the full-app Editor navigation disappears. */
export function closeQuickBuffer(id: string): void {
  buffers.delete(id)
  if (activeTarget?.id === id) activeTarget = null
  emit()
}

/** Return the active file for the full app's persistent quick-file shortcut. */
export function readActiveQuickTarget(): QuickEditTarget | null {
  return activeTarget
}

/** Give useSyncExternalStore a stable revision number. */
export function quickEditorRevision(): number {
  return revision
}

/** Subscribe to quick-file changes while the full app is mounted. */
export function subscribeQuickEditor(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
