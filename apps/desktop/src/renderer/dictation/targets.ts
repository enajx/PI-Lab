/**
 * Places dictated text can go. Terminal and editor panes register themselves here while
 * mounted; the dictation shortcut picks the one that holds keyboard focus. The kind list
 * is open so the agent chat composer can register as a target once it exists.
 */

export type DictationTargetKind = "terminal" | "editor"

export interface DictationTarget {
  kind: DictationTargetKind
  /** The pane: focus inside it makes this the target, and the overlay sits at its bottom. */
  element: HTMLElement
  /** Insert text at the cursor as typed input (a terminal never gets Enter). */
  insert: (text: string) => void
  /** Give keyboard focus back to the pane. */
  focus: () => void
}

const targets = new Set<DictationTarget>()
let lastFocused: DictationTarget | null = null

/** Register a target while its pane is mounted. Returns the function that removes it. */
export function registerDictationTarget(target: DictationTarget): () => void {
  targets.add(target)
  const onFocusIn = (): void => {
    lastFocused = target
  }
  target.element.addEventListener("focusin", onFocusIn)
  if (target.element.contains(document.activeElement)) lastFocused = target
  return () => {
    targets.delete(target)
    target.element.removeEventListener("focusin", onFocusIn)
    if (lastFocused === target) lastFocused = null
  }
}

/** The target whose pane holds keyboard focus now, or null. */
export function focusedDictationTarget(): DictationTarget | null {
  const active = document.activeElement
  if (!active) return null
  for (const target of targets) if (target.element.contains(active)) return target
  return null
}

/**
 * The target that last held keyboard focus, or null. Used when focus has moved away on
 * purpose, as in the command palette's dictation history picker.
 */
export function lastFocusedDictationTarget(): DictationTarget | null {
  return lastFocused
}
