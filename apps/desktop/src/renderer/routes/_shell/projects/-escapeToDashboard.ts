import { useNavigate } from "@tanstack/react-router"
import { useEffect } from "react"

/**
 * Open overlays that take Escape first: the set Settings checks, plus an open
 * disclosure popover (a button with `aria-controls` and `aria-expanded`, such as the
 * LaTeX build log).
 */
const OPEN_OVERLAY =
  '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"], [aria-controls][aria-expanded="true"]'

/**
 * Focus targets that keep Escape: terminals (agents use Escape to interrupt), the
 * CodeMirror and Markdown editors, and text fields.
 */
const KEEPS_ESCAPE =
  '.xterm, .cm-editor, input, textarea, select, [contenteditable]:not([contenteditable="false"])'

/**
 * Escape in the project view returns to the Projects Dashboard, like Escape in
 * Settings returns to the view that opened it. It does nothing when focus is in a
 * terminal, editor or text field, when an inner handler already called
 * `preventDefault` (or stopped the event), or when an overlay was open as the key
 * went down. Overlays are checked in the capture phase, before any handler runs,
 * because several popups close themselves on Escape without `preventDefault`, and
 * React can remove them before the event reaches this bubble-phase listener.
 */
export function useEscapeToDashboard(): void {
  const navigate = useNavigate()
  useEffect(() => {
    let overlayOpen = false
    const onKeyDownCapture = (event: KeyboardEvent): void => {
      if (event.key === "Escape") overlayOpen = document.querySelector(OPEN_OVERLAY) !== null
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || overlayOpen) return
      if (event.target instanceof Element && event.target.closest(KEEPS_ESCAPE)) return
      event.preventDefault()
      void navigate({ to: "/" })
    }
    window.addEventListener("keydown", onKeyDownCapture, true)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDownCapture, true)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [navigate])
}
