/**
 * Open overlays that take keys first: dialogs, menus, listboxes, modal elements,
 * and an open disclosure popover (a button with `aria-controls` and
 * `aria-expanded`, such as the LaTeX build log).
 */
export const OPEN_OVERLAY =
  '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"], [aria-modal="true"], [aria-controls][aria-expanded="true"]'

/**
 * Focus targets that keep Escape: terminals (agents use Escape to interrupt), the
 * CodeMirror and Markdown editors, and text fields.
 */
export const KEEPS_ESCAPE =
  '.xterm, .cm-editor, input, textarea, select, [contenteditable]:not([contenteditable="false"])'

/** Whether an overlay that takes keys first is open in the document. */
export function overlayIsOpen(): boolean {
  return document.querySelector(OPEN_OVERLAY) !== null
}

/**
 * Whether an Escape keydown is free for an app shortcut: no inner handler has
 * called `preventDefault`, no overlay is open, and focus is not in a terminal,
 * editor or text field. Call it in the capture phase so overlays that close on
 * Escape are still in the document.
 */
export function escapeIsFree(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || overlayIsOpen()) return false
  return !(event.target instanceof Element && event.target.closest(KEEPS_ESCAPE))
}
