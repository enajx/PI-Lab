import { useNavigate } from "@tanstack/react-router"
import { useEffect } from "react"
import { KEEPS_ESCAPE, OPEN_OVERLAY } from "../../../shortcuts/keyGuards"

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
