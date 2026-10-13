import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { Button } from "@pi-lab/ui"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { ShutdownBridge, ShutdownRequest } from "../../../../shared/shutdown"
import { drainFileOperations } from "../../../Editor/hooks/useEditorBuffers/fileOperations"
import { useTranslate } from "../../../i18n/language"
import { readRestoreProjectTabs, useRestoreProjectTabs } from "../../../preferences/preferences"
import { useTRPC, useTRPCClient } from "../../../trpc/react"
import { closeDiscardedBuffers, saveProjectBuffer } from "../projects/-workspaceEditorOperations"
import { type AffectedBuffer, isDirtyBuffer } from "../projects/-workspaceRecovery"
import { workspaceRecovery } from "../projects/-workspaceState"
import { useNewFileController } from "./NewFileController"

declare global {
  interface Window {
    piLab?: {
      platform: string
      shutdown: ShutdownBridge
      getPathForFile?: (file: File) => string
      setInterfaceLanguage?: (language: string) => void
    }
  }
}

/** Own recovery warnings and native close decisions above project-route teardown. */
export function WorkspaceRecoveryController() {
  const t = useTranslate()
  const store = workspaceRecovery()
  const trpc = useTRPC()
  const client = useTRPCClient()
  const settings =
    useQuery(trpc.settings.get.queryOptions()).data?.editor ?? DEFAULT_EDITOR_SETTINGS
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const { chooseNewFile } = useNewFileController()
  const [recoveryEnabled] = useRestoreProjectTabs()
  useSyncExternalStore(store.subscribeRecovery, store.getRevision, store.getRevision)
  const [, setSummaryRevision] = useState(0)
  useEffect(() => store.subscribe(() => setSummaryRevision((value) => value + 1)), [store])
  const [request, setRequest] = useState<ShutdownRequest | null>(null)
  const pending = useRef<ShutdownRequest | null>(null)
  const [affected, setAffected] = useState<AffectedBuffer[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  useEffect(() => {
    const bridge = window.piLab?.shutdown
    if (!bridge) return
    return bridge.subscribe((next) => {
      if (pending.current?.requestId === next.requestId) {
        pending.current = next
        setRequest((current) => (current ? next : null))
        return
      }
      if (pending.current) return
      pending.current = next
      // Main already canceled the native event. Wait for in-flight writes and
      // formatter reads before deciding whether the current revision is protected.
      void drainFileOperations().then(() => {
        if (pending.current?.requestId !== next.requestId) return
        store.flush()
        const unprotected = store.affected(readRestoreProjectTabs())
        if (unprotected.length === 0) {
          bridge.respond({ requestId: next.requestId, allow: true })
          pending.current = null
          setRequest(null)
          return
        }
        setRequest(pending.current)
        setAffected(unprotected)
        setError(null)
      })
    })
  }, [store])

  const respond = (allow: boolean): void => {
    const current = pending.current
    if (!current) return
    window.piLab?.shutdown.respond({ requestId: current.requestId, allow })
    pending.current = null
    setRequest(null)
    setAffected([])
    setError(null)
  }

  const currentAffected = (): AffectedBuffer[] => {
    const current = store.affected(readRestoreProjectTabs())
    // A failed explicit save remains an affected item until resolved or discarded,
    // even if its draft becomes recoverable while the dialog stays open.
    for (const previous of affected) {
      const buffer = store
        .read(previous.projectId, true)
        ?.buffers.find((entry) => entry.relPath === previous.buffer.relPath)
      if (
        buffer &&
        isDirtyBuffer(buffer) &&
        !current.some(
          (item) => item.projectId === previous.projectId && item.buffer.relPath === buffer.relPath,
        )
      )
        current.push({ projectId: previous.projectId, buffer })
    }
    return current
  }

  const save = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const latest = currentAffected()
      for (const item of latest) {
        const result = await saveProjectBuffer(
          store,
          client,
          item.projectId,
          item.buffer.relPath,
          settingsRef.current,
          chooseNewFile,
        )
        if (!result.saved) {
          setError(result.error ?? t("Could not save all affected files. PI Lab is still open."))
          setAffected(currentAffected())
          return
        }
      }
      await drainFileOperations()
      store.flush()
      const remaining = store.affected(readRestoreProjectTabs())
      if (remaining.length > 0) {
        setAffected(remaining)
        setError(t("There are newer unsaved edits. PI Lab is still open."))
        return
      }
      respond(true)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const discard = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await drainFileOperations()
      const latest = currentAffected()
      if (!store.discard(latest, closeDiscardedBuffers)) {
        setError(
          t("Could not remove the discarded drafts from recovery storage. PI Lab is still open."),
        )
        setAffected(currentAffected())
        return
      }
      await drainFileOperations()
      store.flush()
      const remaining = store.affected(readRestoreProjectTabs())
      if (remaining.length > 0) {
        setAffected(remaining)
        setError(t("There are newer unsaved edits. PI Lab is still open."))
        return
      }
      respond(true)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const warnings = store.warnings()
  if (!recoveryEnabled && store.affected(false).length > 0)
    warnings.push(
      t("Draft recovery is disabled. Current unsaved edits are not protected across relaunch."),
    )
  return (
    <>
      {warnings.length > 0 ? (
        <div
          data-testid="recovery-warning"
          role="status"
          className="fixed right-4 bottom-4 z-40 max-w-lg rounded-md border border-border bg-popover p-3 text-xs shadow-lg"
        >
          {warnings.map((message) => (
            <p key={message}>{t(message)}</p>
          ))}
        </div>
      ) : null}
      {request ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-background/60 pt-[15vh]">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="unsaved-changes-title"
            className="w-[min(34rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-5 shadow-xl"
          >
            <h2 id="unsaved-changes-title" className="font-semibold">
              {t("Unsaved changes")}
            </h2>
            <p className="mt-2 text-sm">
              {t("These edits are not protected by draft recovery. Save or discard them before")}{" "}
              {request.intent === "quit" ? t("quitting") : t("closing the window")}.
            </p>
            <ul className="my-3 max-h-40 overflow-auto text-sm">
              {affected.map((item) => (
                <li key={`${item.projectId}:${item.buffer.relPath}`}>{item.buffer.relPath}</li>
              ))}
            </ul>
            {error ? (
              <p role="alert" className="my-3 text-destructive text-sm">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => respond(false)}>
                {t("Cancel")}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void discard()}>
                {t("Discard affected")}
              </Button>
              <Button disabled={busy} onClick={() => void save()}>
                {busy ? t("Saving…") : t("Save affected")}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}
