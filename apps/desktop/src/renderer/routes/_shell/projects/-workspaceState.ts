import type { CentralPanelRestoreState } from "./components/CentralPanel/useCentralPanel"

/**
 * In-memory project workspace state. Dashboard navigation intentionally tears down
 * route components, while a project workspace should feel continuous across
 * views and relaunches. Terminal panes are restored by session id; the PTY daemon
 * decides whether that session can still be attached.
 */
export interface ProjectWorkspaceState extends CentralPanelRestoreState {
  rightSidebarCollapsed: boolean
  rightSidebarActiveId: string | null
}

const projectWorkspaceStates = new Map<string, ProjectWorkspaceState>()
const STORAGE_KEY = "pi-lab.projectWorkspaceState.v1"
const CHANGE_EVENT = "pi-lab:project-workspace-state"
let hydrated = false

export function readProjectWorkspaceState(projectId: string): ProjectWorkspaceState | undefined {
  hydrate()
  return projectWorkspaceStates.get(projectId)
}

export function writeProjectWorkspaceState(
  projectId: string,
  state: CentralPanelRestoreState,
): void {
  hydrate()
  const existing = projectWorkspaceStates.get(projectId)
  projectWorkspaceStates.set(projectId, {
    ...state,
    rightSidebarCollapsed: existing?.rightSidebarCollapsed ?? false,
    rightSidebarActiveId: existing?.rightSidebarActiveId ?? null,
  })
  persist()
}

export function writeProjectWorkspaceViewState(
  projectId: string,
  view: Pick<ProjectWorkspaceState, "rightSidebarCollapsed" | "rightSidebarActiveId">,
): void {
  hydrate()
  const existing = projectWorkspaceStates.get(projectId)
  if (!existing) return
  projectWorkspaceStates.set(projectId, { ...existing, ...view })
  persist()
}

/** Subscribe to project-workspace changes made elsewhere in the renderer. */
export function subscribeProjectWorkspaceState(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => window.removeEventListener(CHANGE_EVENT, onChange)
}

function hydrate(): void {
  if (hydrated || typeof window === "undefined") return
  hydrated = true
  const serialized = window.localStorage.getItem(STORAGE_KEY)
  if (!serialized) return
  const entries = JSON.parse(serialized) as Array<[string, ProjectWorkspaceState]>
  for (const [projectId, state] of entries) projectWorkspaceStates.set(projectId, state)
}

function persist(): void {
  if (typeof window === "undefined") return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...projectWorkspaceStates]))
  window.dispatchEvent(new Event(CHANGE_EVENT))
}
