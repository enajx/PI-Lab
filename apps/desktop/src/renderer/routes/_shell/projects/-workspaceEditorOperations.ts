import type { EditorSettings } from "@pi-lab/local-db/editor-settings"
import type { OpenBuffer } from "../../../Editor/hooks/useEditorBuffers"
import {
  BUFFER_ID,
  type BufferAccess,
  type LiveBuffer,
  liveBuffer,
  saveBuffer,
  saveBufferAs,
} from "../../../Editor/hooks/useEditorBuffers/bufferOperations"
import type { PiLabTrpcClient } from "../../../trpc/client"
import type { NewFileResult } from "../components/NewFileController"
import { isUntitledBuffer, type WorkspaceRecoveryStore } from "./-workspaceRecovery"

import type { CentralPanelController } from "./components/CentralPanel/useCentralPanel"

type ActiveEditor = Pick<CentralPanelController, "editor" | "selectFile" | "closeFile">
const activeEditors = new Map<string, () => ActiveEditor>()

/** Registration is route-local; inactive project buffers stay in the recovery store. */
export function registerProjectEditor(
  projectId: string,
  readEditor: () => ActiveEditor,
): () => void {
  activeEditors.set(projectId, readEditor)
  return () => {
    if (activeEditors.get(projectId) === readEditor) activeEditors.delete(projectId)
  }
}

/** Keep mounted views coherent when shutdown removes explicitly discarded drafts. */
export function closeDiscardedBuffers(affected: { projectId: string; buffer: OpenBuffer }[]): void {
  for (const item of affected) activeEditors.get(item.projectId)?.().closeFile(item.buffer.relPath)
}

export interface ProjectSaveResult {
  saved: boolean
  error: string | null
}

/** Save active or retained edits using the exact same revision and destination checks. */
export async function saveProjectBuffer(
  store: WorkspaceRecoveryStore,
  client: PiLabTrpcClient,
  projectId: string,
  relPath: string,
  settings: EditorSettings,
  chooseDestination: (projectId: string) => Promise<NewFileResult | null>,
): Promise<ProjectSaveResult> {
  let error: string | null = null
  try {
    let state = store.read(projectId, true)
    if (!state) return { saved: false, error: `Could not find ${relPath}.` }
    const activeController = activeEditors.get(projectId)?.()
    const activeEditor = activeController?.editor
    if (!activeEditor) {
      store.updateBuffers(projectId, (buffers) =>
        buffers.map((buffer) => (BUFFER_ID in buffer ? buffer : liveBuffer(buffer))),
      )
      state = store.read(projectId, true)
    }
    const inactiveAccess: BufferAccess = {
      read: () => (store.read(projectId, true)?.buffers ?? []) as LiveBuffer[],
      update: (update) =>
        store.updateBuffers(projectId, (buffers) => update(buffers as LiveBuffer[])),
      current: (snapshot) =>
        activeEditors.has(projectId)
          ? undefined
          : (store.read(projectId, true)?.buffers as LiveBuffer[] | undefined)?.find(
              (buffer) =>
                buffer[BUFFER_ID] === snapshot[BUFFER_ID] && buffer.relPath === snapshot.relPath,
            ),
      formatOnSave: () => settings.formatOnSave,
      onSaved: () => {},
      reportError: (message) => {
        error = message
      },
    }
    const originalAccess = activeEditor?.bufferAccess ?? inactiveAccess
    const access: BufferAccess = {
      ...originalAccess,
      reportError: (message) => {
        error = message
        originalAccess.reportError(message)
      },
    }
    const buffer = access.read().find((entry) => entry.relPath === relPath)
    if (!buffer) return { saved: false, error: `Could not find ${relPath}.` }
    const changedSource = (): ProjectSaveResult => ({
      saved: false,
      error: `${relPath} was closed or replaced while saving. PI Lab is still open.`,
    })
    const workspaceId =
      state?.workspaceId || (await client.workspaces.ensureMain.mutate({ projectId })).id
    if (!access.current(buffer)) return changedSource()
    if (buffer.externalChange)
      return {
        saved: false,
        error: `${relPath} changed on disk. Resolve the conflict before quitting.`,
      }
    let saved: boolean
    if (isUntitledBuffer(buffer)) {
      const target = await chooseDestination(projectId)
      if (!target) return { saved: false, error: "Save As was canceled. PI Lab is still open." }
      if (!access.current(buffer)) return changedSource()
      const targetWorkspaceId =
        target.projectId === projectId
          ? workspaceId
          : (await client.workspaces.ensureMain.mutate({ projectId: target.projectId })).id
      if (!access.current(buffer)) return changedSource()
      if (
        target.projectId !== projectId &&
        store
          .read(target.projectId, true)
          ?.buffers.some((entry) => entry.relPath === target.relPath)
      )
        return {
          saved: false,
          error: `${target.relPath} is already open in the destination project.`,
        }
      const result = await saveBufferAs(
        access,
        client,
        workspaceId,
        relPath,
        targetWorkspaceId,
        target.relPath,
      )
      saved = result.saved
      if (result.destination) {
        if (target.projectId === projectId) {
          activeController?.selectFile(target.relPath)
          const latest = store.read(projectId, true)
          if (latest)
            store.write(
              projectId,
              {
                ...latest,
                activeRelPath: target.relPath,
                active: { type: "file", relPath: target.relPath },
              },
              workspaceId,
            )
        } else {
          if (saved) activeController?.closeFile(relPath)
          const targetState = store.read(target.projectId, true)
          const destination = liveBuffer(result.destination)
          const targetEditor = activeEditors.get(target.projectId)?.()
          if (targetEditor) {
            targetEditor.editor.bufferAccess.update((buffers) => [...buffers, destination])
            targetEditor.selectFile(target.relPath)
          }
          store.write(
            target.projectId,
            {
              buffers: [...(targetState?.buffers ?? []), destination],
              activeRelPath: target.relPath,
              active: { type: "file", relPath: target.relPath },
              sessions: targetState?.sessions ?? [],
              belowEditorRun: targetState?.belowEditorRun ?? null,
            },
            targetWorkspaceId,
          )
        }
      }
    } else saved = await saveBuffer(access, client, workspaceId, relPath, false)
    const current = access.read().find((entry) => entry.relPath === relPath)
    if (!saved && !error)
      error = current?.externalChange
        ? `${relPath} changed on disk. Resolve the conflict before quitting.`
        : `${relPath} has newer or unsaved edits. PI Lab is still open.`
    return { saved, error }
  } catch (cause) {
    return {
      saved: false,
      error: `Could not save ${relPath}: ${String(cause)}. PI Lab is still open.`,
    }
  }
}
