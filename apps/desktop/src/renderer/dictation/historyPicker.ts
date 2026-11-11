import { useSyncExternalStore } from "react"

/**
 * Whether the "Dictation history" picker is open. The command palette opens it; the
 * dictation controller renders it.
 */
let open = false
const listeners = new Set<() => void>()

function setOpen(next: boolean): void {
  open = next
  for (const listener of listeners) listener()
}

export function openDictationHistory(): void {
  setOpen(true)
}

export function closeDictationHistory(): void {
  setOpen(false)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useDictationHistoryOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => open,
  )
}
