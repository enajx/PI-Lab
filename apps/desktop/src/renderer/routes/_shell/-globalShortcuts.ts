import { useNavigate } from "@tanstack/react-router"
import { useLayoutEffect, useRef } from "react"
import { escapeIsFree } from "../../shortcuts/keyGuards"
import { eventMatchesShortcut, paletteForKeydown } from "../../shortcuts/shortcuts"
import { rememberSettingsReturnRoute } from "./-settingsReturnRoute"

/**
 * App-global keyboard shortcuts. ⌘, (rebindable) opens Settings; ⇧⌘P (rebindable) opens the
 * command palette, and so does ⌘P outside a project view (inside one, ⌘P opens the project
 * palette). ⌘Escape (rebindable) opens the Projects Dashboard, but only when Escape is free
 * (see {@link escapeIsFree}): focus in an editor, terminal or text field, or an open dialog,
 * menu or popover, keeps the key. Handlers read the *current* binding at event time, so a
 * rebind in Settings takes effect with no listener re-subscription.
 */
export function useGlobalShortcuts(
  pathname: string,
  search: unknown,
  onCommandPalette: () => void,
): void {
  const navigate = useNavigate()
  const paletteRef = useRef(onCommandPalette)
  paletteRef.current = onCommandPalette
  const routeRef = useRef({ pathname, search })
  routeRef.current = { pathname, search }
  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[data-shortcut-recording="true"]')) return
      const palette = paletteForKeydown(event)
      if (palette === "global") {
        event.preventDefault()
        paletteRef.current()
        return
      }
      // The mounted project palette answers this key in its own listener.
      if (palette === "project") return
      if (eventMatchesShortcut(event, "go-to-dashboard")) {
        if (!escapeIsFree(event)) return
        // Stop here so the plain-Escape handlers (project view, Settings) do not also act.
        event.preventDefault()
        event.stopPropagation()
        void navigate({ to: "/" })
        return
      }
      if (routeRef.current.pathname.startsWith("/settings")) return
      if (eventMatchesShortcut(event, "open-settings")) {
        event.preventDefault()
        rememberSettingsReturnRoute(routeRef.current)
        void navigate({ to: "/settings" })
      } else if (
        eventMatchesShortcut(event, "quick-open") &&
        routeRef.current.pathname.startsWith("/projects/")
      ) {
        // This listener is installed before transient Settings listeners, so it prevents a
        // just-closed shortcut recorder from swallowing ⌘F during navigation back to a project.
        event.preventDefault()
        window.dispatchEvent(new Event("pi-lab:open-project-file-finder"))
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [navigate])
}
