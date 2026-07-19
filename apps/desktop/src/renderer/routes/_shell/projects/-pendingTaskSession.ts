import type { SessionPane } from "./components/CentralPanel/useCentralPanel"

export type PendingTaskSession = Omit<SessionPane, "id">

const pendingByProject = new Map<string, PendingTaskSession>()

/**
 * Hand a just-launched task agent from the global Tasks route to the project
 * workspace that will render its terminal. This is deliberately renderer-local:
 * the PTY itself is already owned by the main process; this only carries the
 * pane metadata across the immediate route transition.
 */
export function setPendingTaskSession(projectId: string, session: PendingTaskSession): void {
  pendingByProject.set(projectId, session)
}

/** Read without consuming so React StrictMode's repeated initial render is safe. */
export function readPendingTaskSession(projectId: string): PendingTaskSession | null {
  return pendingByProject.get(projectId) ?? null
}

/** Clear after the project view has mounted the pending terminal pane. */
export function clearPendingTaskSession(projectId: string): void {
  pendingByProject.delete(projectId)
}
