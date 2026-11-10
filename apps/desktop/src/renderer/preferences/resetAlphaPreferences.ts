import {
  isDirtyBuffer,
  isUntitledBuffer,
  latexWorkspaceKey,
  sessionPanelWorkspaceKey,
  type WorkspaceRecoveryStore,
} from "../routes/_shell/projects/-workspaceRecovery"

/**
 * Each project keeps Project view, LaTeX Editor, Tasks and Analysis session panel tabs
 * under separate recovery keys.
 */
function workspaceKeys(projectId: string): string[] {
  return [
    projectId,
    latexWorkspaceKey(projectId),
    sessionPanelWorkspaceKey("tasks", projectId),
    sessionPanelWorkspaceKey("analysis", projectId),
  ]
}

/** Clearing a project must not discard its only copy of unsaved editor work. */
export function alphaProjectsHaveUnsavedWork(
  projectIds: string[],
  recovery: Pick<WorkspaceRecoveryStore, "read" | "warnings">,
): boolean {
  if (recovery.warnings().length > 0) return true
  return projectIds
    .flatMap((id) => workspaceKeys(id))
    .some((id) => {
      const state = recovery.read(id, true)
      return Boolean(
        state?.buffers.some((buffer) => isDirtyBuffer(buffer) || isUntitledBuffer(buffer)) ||
          state?.omittedBuffers?.length,
      )
    })
}

/** Reset renderer preferences without discarding recovered project tabs and buffers. */
export function clearAlphaLocalPreferences(storage: Storage): void {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
  for (const key of keys) {
    if (key?.startsWith("pi-lab.") && !key.startsWith("pi-lab.projectWorkspace.v2.")) {
      storage.removeItem(key)
    }
  }
}

/** Forget renderer state tied to project IDs after Alpha removes those IDs. */
export function clearAlphaProjectUiState(storage: Storage, projectIds: string[]): void {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
  for (const key of keys) {
    if (key === null) continue
    if (
      key === "pi-lab.sidebar.projectOrder" ||
      projectIds.some(
        (id) =>
          workspaceKeys(id).some(
            (workspaceKey) => key === `pi-lab.projectWorkspace.v2.${workspaceKey}`,
          ) || key.startsWith(`pi-lab.project.${id}.`),
      )
    ) {
      storage.removeItem(key)
    }
  }
}
