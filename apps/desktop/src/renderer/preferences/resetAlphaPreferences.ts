import {
  isDirtyBuffer,
  isUntitledBuffer,
  type WorkspaceRecoveryStore,
} from "../routes/_shell/projects/-workspaceRecovery"

/** Clearing a project must not discard its only copy of unsaved editor work. */
export function alphaProjectsHaveUnsavedWork(
  projectIds: string[],
  recovery: Pick<WorkspaceRecoveryStore, "read" | "warnings">,
): boolean {
  if (recovery.warnings().length > 0) return true
  return projectIds.some((id) => {
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
          key === `pi-lab.projectWorkspace.v2.${id}` || key.startsWith(`pi-lab.project.${id}.`),
      )
    ) {
      storage.removeItem(key)
    }
  }
}
