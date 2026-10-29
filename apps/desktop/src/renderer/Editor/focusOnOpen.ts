/**
 * Attribute marking a region (the file tree) whose focused element keeps keyboard
 * focus when a file it opened mounts in the editor, so keys such as ⌘⌫ still reach it.
 */
export const HOLDS_FOCUS_ON_OPEN_ATTR = "data-holds-focus-on-open"

/** True when keyboard focus is inside a region marked with {@link HOLDS_FOCUS_ON_OPEN_ATTR}. */
export function focusHeldOnOpen(): boolean {
  return document.activeElement?.closest(`[${HOLDS_FOCUS_ON_OPEN_ATTR}]`) != null
}
