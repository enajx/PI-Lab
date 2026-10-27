import type { PiLabTrpcClient } from "../../../trpc/client"
import { isPythonPath } from "../../utils/pythonDiagnostics"
import { rejectedReadMessage } from "../../utils/rejectedRead"
import { withFileOperation } from "./fileOperations"
import type { OpenBuffer } from "./useEditorBuffers"

export const BUFFER_ID = Symbol("buffer identity")
export const EDIT_REVISION = Symbol("edit revision")
export type LiveBuffer = OpenBuffer & { [BUFFER_ID]: symbol; [EDIT_REVISION]: number }

/** Restored snapshots receive a fresh identity; live navigation can retain existing identities. */
export function liveBuffer(buffer: OpenBuffer): LiveBuffer {
  return { ...buffer, [BUFFER_ID]: Symbol(buffer.relPath), [EDIT_REVISION]: 0 }
}

export function diskChanged(buffer: OpenBuffer, stat: OpenBuffer["baseline"]): boolean {
  return stat.mtimeMs !== buffer.baseline.mtimeMs || stat.size !== buffer.baseline.size
}

/** Same operations can read the mounted editor or a retained inactive project's current state. */
export interface BufferAccess {
  read: () => LiveBuffer[]
  update: (update: (previous: LiveBuffer[]) => LiveBuffer[]) => void
  current: (snapshot: LiveBuffer) => LiveBuffer | undefined
  reportError: (message: string | null) => void
  formatOnSave: () => boolean
  onSaved: (relPath: string) => void
}

/** Save the exact revision under the shared destination queue, retaining later edits. */
export async function saveBuffer(
  access: BufferAccess,
  client: PiLabTrpcClient,
  workspaceId: string,
  relPath: string,
  overwrite: boolean,
): Promise<boolean> {
  const snapshot = access.read().find((entry) => entry.relPath === relPath)
  if (!snapshot || snapshot.kind === "pdf" || (snapshot.externalChange && !overwrite)) return false
  access.reportError(null)
  return withFileOperation(workspaceId, relPath, async () => {
    let current = access.current(snapshot)
    if (
      !current ||
      current[EDIT_REVISION] !== snapshot[EDIT_REVISION] ||
      (current.externalChange && !overwrite)
    )
      return false
    const before = await client.files.stat.query({ workspaceId, relPath })
    current = access.current(snapshot)
    if (!current || current[EDIT_REVISION] !== snapshot[EDIT_REVISION]) return false
    if (!overwrite && (current.externalChange || diskChanged(current, before))) {
      access.update((previous) =>
        previous.map((entry) =>
          entry[BUFFER_ID] === snapshot[BUFFER_ID] ? { ...entry, externalChange: true } : entry,
        ),
      )
      return false
    }
    const written = await client.files.write.mutate({
      workspaceId,
      relPath,
      content: snapshot.content,
    })
    let savedContent = snapshot.content
    let baseline = written.baseline
    let formatted = false
    if (written.matchesWrittenContent && access.formatOnSave() && isPythonPath(relPath)) {
      const format = await client.diagnostics.format.mutate({ workspaceId, relPath })
      if (format.changed) {
        const read = await client.files.read.query({ workspaceId, relPath })
        if (read.status !== "text") {
          if (!access.current(snapshot)) return false
          const rejectedRead = read.status === "missing" ? undefined : { ...read, relPath }
          access.update((previous) =>
            previous.map((entry) =>
              entry[BUFFER_ID] === snapshot[BUFFER_ID]
                ? { ...entry, externalChange: true, rejectedRead }
                : entry,
            ),
          )
          access.reportError(
            rejectedRead
              ? rejectedReadMessage(rejectedRead)
              : `${relPath} disappeared while formatting. Your draft is preserved; resolve the disk conflict before saving.`,
          )
          return false
        }
        savedContent = read.content
        baseline = read.baseline
        formatted = true
      }
    }
    current = access.current(snapshot)
    if (!current) return false
    const unchanged = current[EDIT_REVISION] === snapshot[EDIT_REVISION]
    access.update((previous) =>
      previous.map((entry) =>
        entry[BUFFER_ID] === snapshot[BUFFER_ID]
          ? {
              ...entry,
              content: formatted && unchanged ? savedContent : entry.content,
              savedContent,
              baseline,
              rejectedRead: undefined,
              externalChange: !written.matchesWrittenContent || (formatted && !unchanged),
              epoch: formatted && unchanged ? entry.epoch + 1 : entry.epoch,
            }
          : entry,
      ),
    )
    access.onSaved(relPath)
    return unchanged && written.matchesWrittenContent
  }).catch((cause: unknown) => {
    if (access.current(snapshot)) access.reportError(`Could not save ${relPath}: ${String(cause)}`)
    return false
  })
}

export interface SaveAsResult {
  saved: boolean
  destination?: OpenBuffer
}

/** Save As reserves a destination through the existing New file dialog, then verifies it. */
export async function saveBufferAs(
  access: BufferAccess,
  client: PiLabTrpcClient,
  workspaceId: string,
  relPath: string,
  targetWorkspaceId: string,
  targetRelPath: string,
): Promise<SaveAsResult> {
  const snapshot = access.read().find((entry) => entry.relPath === relPath)
  if (!snapshot || snapshot.kind === "pdf" || snapshot.externalChange) return { saved: false }
  access.reportError(null)
  return withFileOperation(targetWorkspaceId, targetRelPath, async () => {
    if (!access.current(snapshot)) return { saved: false }
    if (
      workspaceId === targetWorkspaceId &&
      access
        .read()
        .some(
          (entry) => entry.relPath === targetRelPath && entry[BUFFER_ID] !== snapshot[BUFFER_ID],
        )
    )
      throw new Error(`${targetRelPath} is already open`)
    const before = await client.files.stat.query({
      workspaceId: targetWorkspaceId,
      relPath: targetRelPath,
    })
    if (before.exists && before.size > 0) throw new Error(`${targetRelPath} already contains text`)
    if (!access.current(snapshot)) return { saved: false }
    const written = await client.files.write.mutate({
      workspaceId: targetWorkspaceId,
      relPath: targetRelPath,
      content: snapshot.content,
    })
    const current = access.current(snapshot)
    if (!current) return { saved: false }
    const unchanged = current[EDIT_REVISION] === snapshot[EDIT_REVISION]
    const destination: OpenBuffer = {
      ...snapshot,
      relPath: targetRelPath,
      untitled: false,
      savedContent: snapshot.content,
      baseline: written.baseline,
      externalChange: !written.matchesWrittenContent,
    }
    if (workspaceId === targetWorkspaceId) {
      access.update((previous) =>
        previous.map((entry) =>
          entry[BUFFER_ID] === snapshot[BUFFER_ID]
            ? {
                ...entry,
                relPath: targetRelPath,
                untitled: false,
                savedContent: snapshot.content,
                baseline: written.baseline,
                externalChange: !written.matchesWrittenContent,
              }
            : entry,
        ),
      )
    } else {
      // A newer source revision stays untitled in its original project. It can never
      // silently acquire a path that belongs to the destination project.
      access.update((previous) =>
        previous.flatMap((entry) =>
          entry[BUFFER_ID] !== snapshot[BUFFER_ID]
            ? [entry]
            : unchanged && written.matchesWrittenContent
              ? []
              : [{ ...entry, savedContent: snapshot.content }],
        ),
      )
    }
    access.onSaved(targetRelPath)
    return { saved: unchanged && written.matchesWrittenContent, destination }
  }).catch((cause: unknown) => {
    if (access.current(snapshot))
      access.reportError(`Could not save ${targetRelPath}: ${String(cause)}`)
    return { saved: false }
  })
}
