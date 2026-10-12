import { type ProjectWorkspaceState, WorkspaceRecoveryStore } from "./-workspaceRecovery"
import type { CentralPanelRestoreState } from "./components/CentralPanel/useCentralPanel"

export type { ProjectWorkspaceState } from "./-workspaceRecovery"

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
  view: Pick<
    ProjectWorkspaceState,
    "rightSidebarCollapsed" | "rightSidebarActiveId" | "pinnedPanels"
  >,
): void {
  workspaceRecovery().writeView(projectId, view)
}

export function subscribeProjectWorkspaceState(onChange: () => void): () => void {
  return workspaceRecovery().subscribe(onChange)
}
