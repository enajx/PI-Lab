/** Pending editor operations outlive project-view unmounts. */
const pending = new Map<string, Promise<void>>()

/** Serialize writes, formatting and reads for one workspace-relative destination. */
export function withFileOperation<T>(
  workspaceId: string,
  relPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const segments: string[] = []
  for (const segment of relPath.replaceAll("\\", "/").split("/")) {
    if (segment === "..") segments.pop()
    else if (segment && segment !== ".") segments.push(segment)
  }
  const key = JSON.stringify([workspaceId, segments.join("/")])
  const result = (pending.get(key) ?? Promise.resolve()).then(operation)
  // A failed operation is reported to its caller and cannot block the queue.
  const settled = result.then(
    () => {},
    () => {},
  )
  pending.set(key, settled)
  void settled.then(() => {
    if (pending.get(key) === settled) pending.delete(key)
  })
  return result
}

/** Wait for already-started editor operations before a normal shutdown decision. */
export async function drainFileOperations(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending.values()])
}
