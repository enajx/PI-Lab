import type { FileStat, TextSnapshot } from "@pi-lab/workspace-fs"
import type { PythonRuntime } from "../main/python"

export const QUICK_EDIT_OPEN_CHANNEL = "quick-edit:open"
export const QUICK_EDIT_ROUTE_CHANNEL = "quick-edit:route"
export const QUICK_EDIT_RESOLVE_ROUTE_CHANNEL = "quick-edit:resolve-route"
export const QUICK_EDIT_ROUTES_READY_CHANNEL = "quick-edit:routes-ready"
export const QUICK_EDIT_CURRENT_CHANNEL = "quick-edit:current"
export const QUICK_EDIT_READ_CHANNEL = "quick-edit:read"
export const QUICK_EDIT_STAT_CHANNEL = "quick-edit:stat"
export const QUICK_EDIT_SAVE_CHANNEL = "quick-edit:save"
export const QUICK_EDIT_SAVE_UNTITLED_CHANNEL = "quick-edit:save-untitled"
export const QUICK_EDIT_CLOSE_CHANNEL = "quick-edit:close"
export const QUICK_EDIT_READY_CHANNEL = "quick-edit:ready"
export const QUICK_EDIT_EDITOR_VIM_CHANNEL = "quick-edit:editor-vim"
export const QUICK_EDIT_SHOW_FULL_CHANNEL = "quick-edit:show-full"
export const QUICK_EDIT_SHOW_SETTINGS_CHANNEL = "quick-edit:show-settings"
export const QUICK_EDIT_PYTHON_OPTIONS_CHANNEL = "quick-edit:python-options"
export const QUICK_EDIT_PYTHON_SELECT_CHANNEL = "quick-edit:python-select"
export const QUICK_EDIT_PYTHON_RUN_CHANNEL = "quick-edit:python-run"
export const QUICK_EDIT_PYTHON_KILL_CHANNEL = "quick-edit:python-kill"

export interface QuickEditTarget {
  id: string
  path: string
}

export type QuickEditSaveResult =
  | { status: "saved"; baseline: FileStat }
  | { status: "conflict"; baseline: FileStat }

export interface QuickPythonOptionsResult {
  runtime: PythonRuntime
  options: Array<{ path: string; displayName: string; interpreterPath: string }>
}

export interface QuickEditBridge {
  current(): Promise<QuickEditTarget | null>
  read(id: string): Promise<TextSnapshot>
  stat(id: string): Promise<FileStat>
  save(
    id: string,
    content: string,
    expectedBaseline: FileStat,
    overwrite: boolean,
  ): Promise<QuickEditSaveResult>
  saveUntitled(content: string): Promise<{ path: string; route: string } | null>
  pythonOptions(id: string): Promise<QuickPythonOptionsResult>
  pythonSelect(id: string, path: string | null): Promise<PythonRuntime>
  pythonRun(
    id: string,
    cols: number,
    rows: number,
  ): Promise<{ sessionId: string; runtime: PythonRuntime }>
  pythonKill(sessionId: string): Promise<void>
  ready(): void
  subscribeEditorVim(listener: (enabled: boolean) => void): () => void
  close(id: string): Promise<void>
  showFull(id: string): Promise<void>
  showSettings(id: string | null): Promise<void>
  resolveRoute(id: string): Promise<string>
  routesReady(): Promise<string | null>
  subscribeOpen(listener: (target: QuickEditTarget) => void): () => void
  subscribeRoute(listener: (route: string) => void): () => void
}
