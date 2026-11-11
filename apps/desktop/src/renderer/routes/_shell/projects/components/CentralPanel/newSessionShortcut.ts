import { useEffect, useRef, useState } from "react"
import { readNewSessionKind } from "../../../../../preferences/preferences"
import { eventMatchesShortcut } from "../../../../../shortcuts/shortcuts"
import type { CentralPanelController } from "./useCentralPanel"

const IS_MAC = /Mac/.test(navigator.platform)

/**
 * The action the new-session shortcut runs (Settings → Shortcuts): the same controller
 * call as the matching toolbar button, the robot button for a terminal agent, the
 * terminal button for a plain terminal. A terminal agent asked for while the robot
 * button is busy (agents still being detected, or an agent starting) is queued and
 * opens once the button is ready, so an early ⌘T is not lost. The returned function
 * returns false (doing nothing) only for a terminal asked for while one is starting.
 */
export function useOpenNewSession(controller: CentralPanelController): () => boolean {
  const [queued, setQueued] = useState(false)
  const { pendingAgent, openAgent } = controller
  useEffect(() => {
    if (!queued || pendingAgent) return
    setQueued(false)
    openAgent()
  }, [queued, pendingAgent, openAgent])
  return () => {
    if (readNewSessionKind() === "terminal") {
      if (controller.pendingTerminal) return false
      controller.openTerminal()
      return true
    }
    if (controller.pendingAgent) {
      setQueued(true)
      return true
    }
    controller.openAgent()
    return true
  }
}

/**
 * Listen for the new-session shortcut (⌘T, Ctrl+T off macOS) and call `open`, which
 * returns false when it did nothing. It uses the same modifier guards as the split
 * shortcuts: Ctrl+T without ⌘ on macOS (an editor key there) and Ctrl+T in a terminal
 * elsewhere (a shell key) are left alone, and text fields keep the key. The key is
 * consumed only when `open` acted. `open` is read at key time.
 */
export function useNewSessionShortcut(open: () => boolean): void {
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !eventMatchesShortcut(event, "new-session")) return
      if (IS_MAC && event.ctrlKey && !event.metaKey) return
      const target = event.target instanceof Element ? event.target : null
      if (!IS_MAC && event.ctrlKey && target?.closest(".xterm")) return
      if (target?.closest("input, textarea, select") && !target.closest(".xterm")) return
      if (!openRef.current()) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [])
}
