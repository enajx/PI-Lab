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
let untitledDraft = ""
let revision = 0

function emit(): void {
  revision += 1
  for (const listener of listeners) listener()
}

/** Read the latest buffer, including edits made before a route change. */
export function readQuickBuffer(id: string): QuickBuffer | null {
  return buffers.get(id) ?? null
}

/** Return every unsaved outside-project file, including one hidden by navigation. */
export function readDirtyQuickBuffers(): QuickBuffer[] {
  return [...buffers.values()].filter((buffer) => buffer.content !== buffer.savedContent)
}

/** Record a verified save without losing edits made while the write was running. */
export function markQuickBufferSaved(id: string, savedContent: string, baseline: FileStat): void {
  const current = buffers.get(id)
  if (!current) return
  buffers.set(id, { ...current, savedContent, baseline, conflict: false })
  emit()
}

/** Discard unsaved quick drafts only after the user explicitly chooses Discard. */
export function discardQuickDrafts(): void {
  for (const [id, buffer] of buffers) {
    if (buffer.content !== buffer.savedContent) {
      buffers.set(id, { ...buffer, content: buffer.savedContent, conflict: false })
    }
  }
  untitledDraft = ""
  emit()
}

/** Store a draft before React batches its render update. */
export function writeQuickBuffer(buffer: QuickBuffer): void {
  buffers.set(buffer.target.id, buffer)
  activeTarget = buffer.target
  emit()
}

/** Remove a closed file so Editor next opens a fresh Untitled tab. */
export function closeQuickBuffer(id: string): void {
  buffers.delete(id)
  if (activeTarget?.id === id) activeTarget = null
  emit()
}

/** Keep the unsaved Untitled tab while navigating inside the running app. */
export function readUntitledDraft(): string {
  return untitledDraft
}

/** Update the in-memory Untitled draft without writing a file. */
export function writeUntitledDraft(content: string): void {
  untitledDraft = content
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
