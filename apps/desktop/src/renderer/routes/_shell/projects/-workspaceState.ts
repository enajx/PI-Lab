import {
  type ProjectWorkspaceState,
  type ProjectWorkspaceViewState,
  WorkspaceRecoveryStore,
} from "./-workspaceRecovery"
import type { CentralPanelRestoreState } from "./components/CentralPanel/useCentralPanel"

export {
  latexWorkspaceKey,
  type ProjectWorkspaceState,
  type SessionPanelView,
  sessionPanelWorkspaceKey,
} from "./-workspaceRecovery"

let store: WorkspaceRecoveryStore | undefined

/** One live store survives project-route teardown while retaining the last durable snapshots. */
export function workspaceRecovery(): WorkspaceRecoveryStore {
  if (!store) store = new WorkspaceRecoveryStore(window.localStorage)
  return store
}

export function readProjectWorkspaceState(
  projectId: string,
  restoreTabs: boolean,
): ProjectWorkspaceState | undefined {
  return workspaceRecovery().read(projectId, restoreTabs)
}

export function writeProjectWorkspaceState(
  projectId: string,
  state: CentralPanelRestoreState,
  workspaceId?: string,
): void {
  workspaceRecovery().write(projectId, state, workspaceId)
}

export function writeProjectWorkspaceViewState(
  projectId: string,
  view: ProjectWorkspaceViewState,
): void {
  workspaceRecovery().writeView(projectId, view)
}

/** The project's pinned right-sidebar panels, shared by the project view and the science views. */
export function readProjectPinnedPanels(projectId: string): string[] {
  return workspaceRecovery().read(projectId, true)?.pinnedPanels ?? []
}

/** Save the project's pinned right-sidebar panels from a science view. */
export function writeProjectPinnedPanels(projectId: string, pinnedPanels: string[]): void {
  workspaceRecovery().writePinnedPanels(projectId, pinnedPanels)
}

export function subscribeProjectWorkspaceState(onChange: () => void): () => void {
  return workspaceRecovery().subscribe(onChange)
}
