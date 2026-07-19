/**
 * Browser-safe built-in editor preferences. This module deliberately has no
 * database or Node imports so the renderer can consume the canonical defaults
 * without pulling the local-db migration/runtime barrel into its bundle.
 */
import type { ImportedEditorTheme } from "./editorThemeImport"

export type {
  ImportedEditorTheme,
  ImportedEditorThemeColors,
  ImportedEditorTokenColor,
} from "./editorThemeImport"

export type PythonRunDestination = "central" | "below-editor"

export interface EditorSettings {
  /** Save on debounce/blur instead of requiring an explicit ⌘S (default off). */
  autosave: boolean
  /** Enable the CodeMirror Vim keymap (default off). */
  vim: boolean
  /** Run Python type-checking and lint diagnostics in the editor (default off). */
  diagnosticsEnabled: boolean
  /** Which Python type checker the diagnostics run uses (default `ty`). */
  typeChecker: "ty" | "pyrefly"
  /** Run `ruff format` on ⌘S, then reload the buffer (default off). */
  formatOnSave: boolean
  /**
   * Stored id of the editor color theme. Kept a plain string so persistence
   * never couples to the renderer's theme registry.
   */
  editorTheme: string
  /** Parsed/copied custom themes; external source paths are never retained. */
  customEditorThemes: ImportedEditorTheme[]
  /** Default destination for Run Python; each run may override it. */
  pythonRunDestination: PythonRunDestination
}

/** Spec defaults for {@link EditorSettings}. */
export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  autosave: false,
  vim: false,
  diagnosticsEnabled: false,
  typeChecker: "ty",
  formatOnSave: false,
  editorTheme: "default",
  customEditorThemes: [],
  pythonRunDestination: "central",
}
