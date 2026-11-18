/**
 * Where a project opens: local projects at `/projects/$projectId` (unchanged),
 * projects of a remote machine at `/m/$machineId/projects/$projectId`.
 */
export function projectRoute(machineId: string | null, projectId: string) {
  return machineId === null
    ? ({ to: "/projects/$projectId", params: { projectId } } as const)
    : ({ to: "/m/$machineId/projects/$projectId", params: { machineId, projectId } } as const)
}

/** True for a project view path, local or remote. */
export function isProjectPath(path: string): boolean {
  return path.startsWith("/projects/") || /^\/m\/[^/]+\/projects\//.test(path)
}
