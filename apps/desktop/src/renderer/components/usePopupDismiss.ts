import { type RefObject, useEffect, useRef } from "react"

/** How many popups are open now; the page stays marked while any is. */
let openCount = 0

/**
 * Close a popup menu or popover (`open`) on a pointerdown or mousedown outside
 * every element in `refs` (both, since a pointerdown handler that calls
 * `preventDefault` stops the mousedown) and on Escape. It stays open when the window
 * loses focus, because a native dialog the popup opened (a folder picker) takes the
 * focus and the popup's flow must go on. While it is open the page
 * root carries `data-popup-open`, which turns the window drag regions
 * (`.app-drag`, see globals.css) into normal page areas: Electron does not send
 * mouse events from a drag region to the page, so without this a click on the
 * top bar would never reach the outside-click check. `onClose` may change on
 * every render; the latest one runs.
 */
export function usePopupDismiss(
  open: boolean,
  refs: RefObject<HTMLElement | null>[],
  onClose: () => void,
): void {
  const latest = useRef({ refs, onClose })
  latest.current = { refs, onClose }

  useEffect(() => {
    if (!open) return
    const root = document.documentElement
    openCount += 1
    root.setAttribute("data-popup-open", "")
    const onPress = (event: MouseEvent) => {
      const target = event.target as Node
      if (latest.current.refs.some((ref) => ref.current?.contains(target))) return
      latest.current.onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") latest.current.onClose()
    }
    window.addEventListener("pointerdown", onPress)
    window.addEventListener("mousedown", onPress)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("pointerdown", onPress)
      window.removeEventListener("mousedown", onPress)
      window.removeEventListener("keydown", onKeyDown)
      openCount -= 1
      if (openCount === 0) root.removeAttribute("data-popup-open")
    }
  }, [open])
}
