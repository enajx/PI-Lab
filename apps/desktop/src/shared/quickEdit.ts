import type { FileStat, TextSnapshot } from "@pi-lab/workspace-fs"

export const QUICK_EDIT_OPEN_CHANNEL = "quick-edit:open"
export const QUICK_EDIT_ROUTE_CHANNEL = "quick-edit:route"
export const QUICK_EDIT_RESOLVE_ROUTE_CHANNEL = "quick-edit:resolve-route"
export const QUICK_EDIT_ROUTES_READY_CHANNEL = "quick-edit:routes-ready"
export const QUICK_EDIT_CURRENT_CHANNEL = "quick-edit:current"
export const QUICK_EDIT_READ_CHANNEL = "quick-edit:read"
export const QUICK_EDIT_STAT_CHANNEL = "quick-edit:stat"
export const QUICK_EDIT_SAVE_CHANNEL = "quick-edit:save"
export const QUICK_EDIT_CLOSE_CHANNEL = "quick-edit:close"
export const QUICK_EDIT_READY_CHANNEL = "quick-edit:ready"
export const QUICK_EDIT_SHOW_FULL_CHANNEL = "quick-edit:show-full"

export interface QuickEditTarget {
  id: string
  path: string
}

export type QuickEditSaveResult =
  | { status: "saved"; baseline: FileStat }
  | { status: "conflict"; baseline: FileStat }

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
  ready(): void
  close(id: string): Promise<void>
  showFull(id: string): Promise<void>
  resolveRoute(id: string): Promise<string>
  routesReady(): Promise<string | null>
  subscribeOpen(listener: (target: QuickEditTarget) => void): () => void
  subscribeRoute(listener: (route: string) => void): () => void
}
