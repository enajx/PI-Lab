import { python } from "@codemirror/lang-python"
import type { Extension } from "@codemirror/state"

/**
 * Pick a CodeMirror language extension from a file's path. v1 ships Python
 * highlighting only (AGENTS.md §1 / TODO "Built-in editor" — Python first); any
 * other extension returns `null`, leaving the buffer as plain text. Kept a pure
 * function (no view, no I/O) so the by-extension mapping is unit-testable in
 * isolation and the integrate stage can extend it with more `lang-*` packages.
 */
export function languageForPath(relPath: string): Extension | null {
  const ext = extensionOf(relPath)
  switch (ext) {
    case "py":
    case "pyi":
    case "pyw":
      return python()
    default:
      return null
  }
}

/** Lower-cased final extension of a path (no dot), or "" when there is none. */
export function extensionOf(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath
  const dot = base.lastIndexOf(".")
  // A leading dot (dotfile, e.g. `.gitignore`) is not an extension.
  if (dot <= 0) return ""
  return base.slice(dot + 1).toLowerCase()
}
