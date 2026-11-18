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

/**
 * Wait for already-started editor operations before a shutdown decision, for
 * at most `timeoutMs`. A save the server cannot answer (it is down; tRPC holds
 * the call until it reconnects) must not hold the decision forever: its
 * buffer is still dirty, so the caller treats it as unsaved.
 */
export async function drainFileOperations(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (pending.size > 0) {
    const left = deadline - Date.now()
    if (left <= 0) return
    await Promise.race([
      Promise.all([...pending.values()]),
      new Promise((resolve) => setTimeout(resolve, left)),
    ])
  }
}

/** How long a quit decision waits for in-flight saves (see {@link drainFileOperations}). */
export const SHUTDOWN_DRAIN_MS = 3_000
