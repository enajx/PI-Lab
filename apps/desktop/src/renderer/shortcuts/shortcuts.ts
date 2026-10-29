import { useCallback, useEffect, useState } from "react"

/**
 * App-global keyboard-shortcut registry (Settings → Shortcuts). A small,
 * localStorage-backed map of action id → binding so the handful of v1 global
 * shortcuts are rebindable. CodeMirror-internal bindings (e.g. ⌘S) are listed
 * for reference but not rebound here — rebinding the editor keymap is a follow-up.
 *
 * Handlers read the *current* binding at event time via {@link eventMatchesShortcut}
 * (non-reactive), so a rebind in Settings takes effect immediately without any
 * listener re-subscription. The Settings section uses {@link useShortcutBindings}.
 */

export interface ShortcutDef {
  /** Stable id (registry key + React key). */
  id: string
  label: string
  description: string
  /** Default binding, e.g. `"Mod+,"`. `Mod` = ⌘ on macOS / Ctrl elsewhere. */
  defaultBinding: string
  /** App-global (rebindable) vs. reference-only (shown but not editable in v1). */
  editable: boolean
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  {
    id: "open-settings",
    label: "Open Settings",
    description: "Open the Settings panel",
    defaultBinding: "Mod+,",
    editable: true,
  },
  {
    id: "command-palette",
    label: "Command palette",
    description: "Search commands and projects",
    defaultBinding: "Mod+Shift+p",
    editable: true,
  },
  {
    id: "quick-open",
    label: "Quick open file",
    description: "Search and open a file in the project view",
    defaultBinding: "Mod+f",
    editable: true,
  },
  {
    id: "project-command-palette",
    label: "Project command palette",
    description: "Run a project action (open agent/terminal/file, switch panel) inside a project",
    defaultBinding: "Mod+p",
    editable: true,
  },
  {
    id: "split-right",
    label: "Split right",
    description: "Split the focused terminal: a new terminal opens beside it",
    defaultBinding: "Mod+d",
    editable: true,
  },
  {
    id: "split-down",
    label: "Split down",
    description: "Split the focused terminal: a new terminal opens below it",
    defaultBinding: "Mod+Shift+d",
    editable: true,
  },
  {
    id: "save-file",
    label: "Save file",
    description: "Save the active editor buffer (CodeMirror)",
    defaultBinding: "Mod+s",
    editable: false,
  },
  {
    id: "run-python",
    label: "Run Python file",
    description: "Save and run the focused Python editor buffer",
    defaultBinding: "Mod+Enter",
    editable: false,
  },
]

const STORAGE_KEY = "pi-lab.shortcuts"
type Bindings = Record<string, string>

function readBindings(): Bindings {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Bindings) : {}
  } catch {
    return {}
  }
}

function writeBindings(bindings: Bindings): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings))
  } catch {
    // Best-effort persistence.
  }
}

function defaultBinding(id: string): string {
  return SHORTCUTS.find((shortcut) => shortcut.id === id)?.defaultBinding ?? ""
}

/** The active binding for a shortcut (override if set, else its default). */
export function getBinding(id: string): string {
  return readBindings()[id] ?? defaultBinding(id)
}

/** Whether a keydown matches a binding string like `"Mod+,"` / `"Mod+Shift+p"`. */
export function matchesBinding(event: KeyboardEvent, binding: string): boolean {
  if (!binding) return false
  const parts = binding.split("+")
  const key = (parts.at(-1) ?? "").toLowerCase()
  const hasMod = event.metaKey || event.ctrlKey
  if (parts.includes("Mod") !== hasMod) return false
  if (parts.includes("Shift") !== event.shiftKey) return false
  if (parts.includes("Alt") !== event.altKey) return false
  return event.key.toLowerCase() === key
}

/** Whether a keydown matches a registered shortcut's current binding. */
export function eventMatchesShortcut(event: KeyboardEvent, id: string): boolean {
  return matchesBinding(event, getBinding(id))
}

let mountedProjectPalettes = 0

/**
 * Record that a project palette is mounted (a project view is open). Returns the
 * cleanup that removes the record. Outside a project view, the project-palette
 * shortcut opens the global palette instead (see {@link paletteForKeydown}).
 */
export function registerProjectPalette(): () => void {
  mountedProjectPalettes += 1
  return () => {
    mountedProjectPalettes -= 1
  }
}

/**
 * Which palette a keydown opens, or `null` when it is not a palette shortcut. The
 * `command-palette` binding (⇧⌘P) always opens the global palette. The
 * `project-command-palette` binding (⌘P) opens the project palette while one is
 * mounted, and the global palette everywhere else. Exactly one palette answers a key.
 */
export function paletteForKeydown(event: KeyboardEvent): "global" | "project" | null {
  if (eventMatchesShortcut(event, "command-palette")) return "global"
  if (!eventMatchesShortcut(event, "project-command-palette")) return null
  return mountedProjectPalettes > 0 ? "project" : "global"
}

/**
 * Render a binding for display with modifiers in the macOS order (⌥⇧⌘):
 * `"Mod+,"` → `"⌘,"`, `"Mod+Shift+p"` → `"⇧⌘P"`.
 */
export function formatBinding(binding: string): string {
  const parts = binding.split("+")
  const key = parts.at(-1) ?? ""
  const modifiers =
    (parts.includes("Alt") ? "⌥" : "") +
    (parts.includes("Shift") ? "⇧" : "") +
    (parts.includes("Mod") ? "⌘" : "")
  return modifiers + key.toUpperCase()
}

/**
 * Return the first action already using `binding`, in registry order. The
 * current action is excluded so recording its existing chord remains a valid
 * no-op. Reference-only editor actions participate too: an app-global binding
 * must not shadow a fixed CodeMirror key.
 */
export function findShortcutConflict(
  shortcutId: string,
  binding: string,
  bindingFor: (id: string) => string,
): ShortcutDef | null {
  return (
    SHORTCUTS.find(
      (shortcut) => shortcut.id !== shortcutId && bindingFor(shortcut.id) === binding,
    ) ?? null
  )
}

/** Reactive bindings + setters for the Settings → Shortcuts section. */
export function useShortcutBindings(): {
  bindingFor: (id: string) => string
  setBinding: (id: string, binding: string) => void
  resetBinding: (id: string) => void
} {
  const [bindings, setBindings] = useState<Bindings>(() => readBindings())
  useEffect(() => {
    writeBindings(bindings)
  }, [bindings])

  const setBinding = useCallback((id: string, binding: string) => {
    setBindings((prev) => ({ ...prev, [id]: binding }))
  }, [])
  const resetBinding = useCallback((id: string) => {
    setBindings((prev) => {
      const { [id]: _removed, ...rest } = prev
      return rest
    })
  }, [])
  const bindingFor = useCallback((id: string) => bindings[id] ?? defaultBinding(id), [bindings])
  return { bindingFor, setBinding, resetBinding }
}

/** Build a binding string from a captured keydown (for the rebind recorder). */
export function bindingFromEvent(event: KeyboardEvent): string | null {
  const key = event.key
  // Ignore lone modifier presses — wait for the real key.
  if (["Meta", "Control", "Shift", "Alt"].includes(key)) return null
  const parts: string[] = []
  if (event.metaKey || event.ctrlKey) parts.push("Mod")
  if (event.shiftKey) parts.push("Shift")
  if (event.altKey) parts.push("Alt")
  parts.push(key.length === 1 ? key.toLowerCase() : key)
  return parts.join("+")
}
