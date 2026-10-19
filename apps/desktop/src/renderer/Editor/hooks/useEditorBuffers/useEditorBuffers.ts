import type { EditorSettings } from "@pi-lab/local-db/editor-settings"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { PiLabTrpcClient } from "../../../trpc/client"
import type { RouterOutputs } from "../../../trpc/types"
import type { DiagnosticsSource } from "../../components/CodeMirrorBuffer"
import {
  countDiagnostics,
  type DiagnosticCounts,
  type DiagnosticsRunResult,
  isPythonPath,
  runPythonCheck,
  toCmDiagnostics,
} from "../../utils/pythonDiagnostics"
import type { RejectedRead } from "../../utils/rejectedRead"
import {
  BUFFER_ID,
  type BufferAccess,
  diskChanged,
  EDIT_REVISION,
  type LiveBuffer,
  liveBuffer,
  saveBuffer,
  saveBufferAs,
} from "./bufferOperations"
import { withFileOperation } from "./fileOperations"

/** A file's fingerprint on disk at the moment we last read it. */
interface DiskBaseline {
  mtimeMs: number
  size: number
}

/** In-memory state for one open file. */
export interface OpenBuffer {
  /** Explicit identity for files that have not been saved to disk. */
  untitled?: boolean
  relPath: string
  /** Live document text (what CodeMirror shows). */
  content: string
  /** Text last loaded from / saved to disk — the dirty comparison baseline. */
  savedContent: string
  /** Disk fingerprint at the last load/save, for external-change detection. */
  baseline: DiskBaseline
  /** Set when the file changed on disk while this buffer was dirty. */
  externalChange: boolean
  /** Forces a fresh CodeMirror mount when bumped (after an external auto-reload). */
  epoch: number
  /** Metadata for a rejected reload, retained with the draft across navigation. */
  rejectedRead?: RejectedRead
}

interface DiagnosticsState {
  result: DiagnosticsRunResult | null
  checking: boolean
  hasRun: boolean
}

export interface PythonRuntimeState {
  runtime: RouterOutputs["python"]["resolve"] | null
  checking: boolean
  error: string | null
}

const STAT_POLL_MS = 1_500
const PYTHON_ENV_RECHECK_MS = 3_000
const AUTOSAVE_DEBOUNCE_MS = 800

export { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"

const EMPTY_DIAGNOSTICS: DiagnosticsState = { result: null, checking: false, hasRun: false }
const EMPTY_COUNTS: DiagnosticCounts = { errors: 0, warnings: 0, infos: 0 }
const EMPTY_PYTHON_RUNTIME: PythonRuntimeState = {
  runtime: null,
  checking: false,
  error: null,
}

export interface UseEditorBuffersArgs {
  client: PiLabTrpcClient
  workspaceId: string
  settings: EditorSettings
  onSaved?: (relPath: string) => void
  /** In-memory buffers restored after temporarily leaving this project view. */
  initialBuffers?: OpenBuffer[]
  initialActiveRelPath?: string | null
  onBuffersChange?: (buffers: OpenBuffer[]) => void
}

export interface EditorBuffersApi {
  bufferAccess: BufferAccess
  buffers: OpenBuffer[]
  active: OpenBuffer | null
  activeRelPath: string | null
  setActiveRelPath: (relPath: string | null) => void
  /** Open a file (or focus it if already open) and make it the active buffer. */
  openFile: (relPath: string) => Promise<void>
  /** Open a blank, unsaved buffer without creating a file on disk. */
  openUntitled: (relPath: string) => void
  closeFile: (relPath: string) => void
  onEdit: (relPath: string, content: string) => void
  saveFile: (relPath: string) => Promise<boolean>
  overwriteFile: (relPath: string) => Promise<boolean>
  reloadFile: (relPath: string) => Promise<boolean>
  /** Save an untitled buffer to a user-chosen project-relative path. */
  saveAs: (relPath: string, targetRelPath: string) => Promise<boolean>
  error: string | null
  rejectedRead: RejectedRead | null
  revealRejectedRead: () => Promise<void>
  tabs: { relPath: string; dirty: boolean }[]
  diagnosticsSource: DiagnosticsSource | undefined
  statusCounts: DiagnosticCounts
  statusMissing: string[]
  activeDiagnostics: DiagnosticsState
  pythonRuntime: PythonRuntimeState
  listPythonEnvironments: () => Promise<RouterOutputs["python"]["options"]>
  selectPythonEnvironment: (path: string | null) => Promise<boolean>
  choosePythonEnvironment: (kind: "directory" | "interpreter") => Promise<boolean>
  /** Save the active buffer on blur when autosave is on (tab/focus loss). */
  onBlurCapture: () => void
}

/**
 * The editor's open-buffer machinery: open buffers, the active path, save,
 * external-change reconciliation, autosave, and one-shot Python diagnostics. The
 * project view's central panel hosts file tabs at the top level (with the file
 * tree in the right-sidebar Files panel) — both drive one buffer set through this
 * hook. Reads/writes go through the injected tRPC client so it stays testable with
 * the fake client.
 */
export function useEditorBuffers({
  client,
  workspaceId,
  settings,
  onSaved,
  initialBuffers,
  initialActiveRelPath,
  onBuffersChange,
}: UseEditorBuffersArgs): EditorBuffersApi {
  const [buffers, setBufferState] = useState<LiveBuffer[]>(() =>
    (initialBuffers ?? []).map(liveBuffer),
  )
  const [activeRelPath, setActiveRelPath] = useState<string | null>(
    () => initialActiveRelPath ?? null,
  )
  const [error, setError] = useState<string | null>(null)
  const [rejectedOpen, setRejectedOpen] = useState<RejectedRead | null>(null)
  const [diagnostics, setDiagnostics] = useState<Record<string, DiagnosticsState>>({})
  const [pythonRuntime, setPythonRuntime] = useState<PythonRuntimeState>(EMPTY_PYTHON_RUNTIME)

  const onBuffersChangeRef = useRef(onBuffersChange)
  onBuffersChangeRef.current = onBuffersChange
  const buffersRef = useRef(buffers)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  // Update the ref in the same call as state, so edits and async completions in
  // the same React batch always inspect the latest buffer.
  const setBuffers = useCallback((update: (previous: LiveBuffer[]) => LiveBuffer[]) => {
    if (!mountedRef.current) return
    const next = update(buffersRef.current)
    buffersRef.current = next
    onBuffersChangeRef.current?.(next)
    setBufferState(next)
  }, [])
  const currentInstance = useCallback((snapshot: LiveBuffer): LiveBuffer | undefined => {
    if (!mountedRef.current) return undefined
    return buffersRef.current.find(
      (entry) => entry[BUFFER_ID] === snapshot[BUFFER_ID] && entry.relPath === snapshot.relPath,
    )
  }, [])
  const openRequestsRef = useRef(new Map<string, symbol>())
  const externalCheckRef = useRef(false)
  const activeRef = useRef(activeRelPath)
  activeRef.current = activeRelPath
  const typeCheckerRef = useRef(settings.typeChecker)
  typeCheckerRef.current = settings.typeChecker
  const diagnosticsEnabledRef = useRef(settings.diagnosticsEnabled)
  diagnosticsEnabledRef.current = settings.diagnosticsEnabled
  const formatOnSaveRef = useRef(settings.formatOnSave)
  formatOnSaveRef.current = settings.formatOnSave
  const wasPythonActiveRef = useRef(false)
  const pythonRuntimeWorkspaceRef = useRef<string | null>(null)
  const pythonRuntimeRequestRef = useRef(0)
  const pythonLocalCheckInFlightRef = useRef(false)
  const diagnosticsEpochRef = useRef(0)

  const active = buffers.find((buffer) => buffer.relPath === activeRelPath) ?? null

  const patchDiagnostics = useCallback((relPath: string, patch: Partial<DiagnosticsState>) => {
    setDiagnostics((prev) => ({
      ...prev,
      [relPath]: { ...(prev[relPath] ?? EMPTY_DIAGNOSTICS), ...patch },
    }))
  }, [])

  const runDiagnostics = useCallback(
    async (relPath: string) => {
      if (!diagnosticsEnabledRef.current || !isPythonPath(relPath)) return
      const epoch = diagnosticsEpochRef.current
      patchDiagnostics(relPath, { checking: true })
      try {
        const result = await runPythonCheck(client, {
          workspaceId,
          relPath,
          typeChecker: typeCheckerRef.current,
        })
        // A check may finish after the user turns diagnostics off. Ignore that
        // stale response; the disabling effect below has already cleared state.
        if (!diagnosticsEnabledRef.current || diagnosticsEpochRef.current !== epoch) return
        if (result) patchDiagnostics(relPath, { result, checking: false, hasRun: true })
        else patchDiagnostics(relPath, { checking: false })
      } catch {
        if (!diagnosticsEnabledRef.current || diagnosticsEpochRef.current !== epoch) return
        patchDiagnostics(relPath, { checking: false })
      }
    },
    [client, workspaceId, patchDiagnostics],
  )

  // Turning diagnostics off removes existing lint markers/counts immediately.
  // Turning them on checks the already-focused Python buffer without requiring
  // the user to close/reopen or save it first.
  useEffect(() => {
    if (!settings.diagnosticsEnabled) {
      diagnosticsEpochRef.current += 1
      setDiagnostics({})
      return
    }
    const relPath = activeRef.current
    if (relPath && isPythonPath(relPath)) void runDiagnostics(relPath)
  }, [settings.diagnosticsEnabled, runDiagnostics])

  const openFile = useCallback(
    async (relPath: string) => {
      setError(null)
      setRejectedOpen(null)
      const existing = buffersRef.current.find((buffer) => buffer.relPath === relPath)
      if (existing) {
        setActiveRelPath(relPath)
        return
      }
      const request = Symbol(relPath)
      openRequestsRef.current.set(relPath, request)
      try {
        const read = await withFileOperation(workspaceId, relPath, () =>
          client.files.read.query({ workspaceId, relPath }),
        )
        if (!mountedRef.current || openRequestsRef.current.get(relPath) !== request) return
        openRequestsRef.current.delete(relPath)
        if (read.status === "oversized" || read.status === "binary") {
          setRejectedOpen({ ...read, relPath })
          return
        }
        const content = read.content
        setBuffers((prev) => {
          if (prev.some((buffer) => buffer.relPath === relPath)) return prev
          return [
            ...prev,
            liveBuffer({
              relPath,
              content,
              savedContent: content,
              baseline: read.baseline,
              externalChange: false,
              epoch: 0,
            }),
          ]
        })
        setActiveRelPath(relPath)
        void runDiagnostics(relPath)
      } catch (cause) {
        if (mountedRef.current && openRequestsRef.current.get(relPath) === request) {
          openRequestsRef.current.delete(relPath)
          setError(`Could not open ${relPath}: ${String(cause)}`)
        }
      }
    },
    [client, workspaceId, runDiagnostics, setBuffers],
  )

  const openUntitled = useCallback(
    (relPath: string) => {
      openRequestsRef.current.delete(relPath)
      setError(null)
      setBuffers((previous) => {
        if (previous.some((buffer) => buffer.relPath === relPath)) return previous
        return [
          ...previous,
          liveBuffer({
            relPath,
            untitled: true,
            content: "",
            savedContent: "",
            baseline: { mtimeMs: 0, size: 0 },
            externalChange: false,
            epoch: 0,
          }),
        ]
      })
      setActiveRelPath(relPath)
    },
    [setBuffers],
  )

  const closeFile = useCallback(
    (relPath: string) => {
      openRequestsRef.current.delete(relPath)
      setBuffers((prev) => {
        const next = prev.filter((buffer) => buffer.relPath !== relPath)
        setActiveRelPath((current) =>
          current === relPath ? (next.at(-1)?.relPath ?? null) : current,
        )
        return next
      })
      setDiagnostics((prev) => {
        if (!(relPath in prev)) return prev
        const { [relPath]: _removed, ...rest } = prev
        return rest
      })
    },
    [setBuffers],
  )

  const onEdit = useCallback(
    (relPath: string, content: string) => {
      setBuffers((prev) =>
        prev.map((buffer) =>
          buffer.relPath === relPath && buffer.content !== content
            ? { ...buffer, content, [EDIT_REVISION]: buffer[EDIT_REVISION] + 1 }
            : buffer,
        ),
      )
    },
    [setBuffers],
  )

  const bufferAccess = useMemo<BufferAccess>(
    () => ({
      read: () => buffersRef.current,
      update: setBuffers,
      current: currentInstance,
      reportError: setError,
      formatOnSave: () => formatOnSaveRef.current,
      onSaved: (relPath) => {
        onSaved?.(relPath)
        void runDiagnostics(relPath)
      },
    }),
    [setBuffers, currentInstance, onSaved, runDiagnostics],
  )

  const saveFile = useCallback(
    (relPath: string) => saveBuffer(bufferAccess, client, workspaceId, relPath, false),
    [bufferAccess, client, workspaceId],
  )
  const overwriteFile = useCallback(
    (relPath: string) => saveBuffer(bufferAccess, client, workspaceId, relPath, true),
    [bufferAccess, client, workspaceId],
  )
  const saveAs = useCallback(
    async (relPath: string, targetRelPath: string): Promise<boolean> => {
      const result = await saveBufferAs(
        bufferAccess,
        client,
        workspaceId,
        relPath,
        workspaceId,
        targetRelPath,
      )
      if (result.destination)
        setActiveRelPath((active) => (active === relPath ? targetRelPath : active))
      return result.saved
    },
    [bufferAccess, client, workspaceId],
  )

  const reload = useCallback(
    async (snapshot: LiveBuffer, explicit: boolean): Promise<boolean> => {
      return withFileOperation(workspaceId, snapshot.relPath, async () => {
        const current = currentInstance(snapshot)
        if (!current) return false
        const stat = await client.files.stat.query({ workspaceId, relPath: snapshot.relPath })
        const afterStat = currentInstance(snapshot)
        if (!afterStat) return false
        if (!explicit && !diskChanged(afterStat, stat)) return true
        if (
          !explicit &&
          (afterStat.externalChange || afterStat.content !== afterStat.savedContent)
        ) {
          setBuffers((previous) =>
            previous.map((entry) =>
              entry[BUFFER_ID] === snapshot[BUFFER_ID] ? { ...entry, externalChange: true } : entry,
            ),
          )
          return false
        }
        const read = await client.files.read.query({ workspaceId, relPath: snapshot.relPath })
        const latest = currentInstance(snapshot)
        if (!latest) return false
        if (read.status === "oversized" || read.status === "binary") {
          setBuffers((previous) =>
            previous.map((entry) =>
              entry[BUFFER_ID] === snapshot[BUFFER_ID]
                ? {
                    ...entry,
                    externalChange: true,
                    rejectedRead: { ...read, relPath: snapshot.relPath },
                  }
                : entry,
            ),
          )
          return false
        }
        if (latest[EDIT_REVISION] !== snapshot[EDIT_REVISION]) {
          setBuffers((previous) =>
            previous.map((entry) =>
              entry[BUFFER_ID] === snapshot[BUFFER_ID] ? { ...entry, externalChange: true } : entry,
            ),
          )
          return false
        }
        setBuffers((previous) =>
          previous.map((entry) =>
            entry[BUFFER_ID] === snapshot[BUFFER_ID]
              ? {
                  ...entry,
                  content: read.content,
                  savedContent: read.content,
                  baseline: read.baseline,
                  externalChange: false,
                  rejectedRead: undefined,
                  epoch: entry.epoch + 1,
                  [EDIT_REVISION]: entry[EDIT_REVISION] + 1,
                }
              : entry,
          ),
        )
        void runDiagnostics(snapshot.relPath)
        return true
      }).catch((cause: unknown) => {
        if (currentInstance(snapshot))
          setError(`Could not reload ${snapshot.relPath}: ${String(cause)}`)
        return false
      })
    },
    [client, workspaceId, currentInstance, setBuffers, runDiagnostics],
  )

  const reloadFile = useCallback(
    (relPath: string): Promise<boolean> => {
      const snapshot = buffersRef.current.find((entry) => entry.relPath === relPath)
      return snapshot ? reload(snapshot, true) : Promise.resolve(false)
    },
    [reload],
  )

  const refreshPythonRuntime = useCallback(async (): Promise<void> => {
    pythonRuntimeRequestRef.current += 1
    const requestId = pythonRuntimeRequestRef.current
    setPythonRuntime((current) => ({ ...current, checking: true, error: null }))
    try {
      const runtime = await client.python.resolve.query({ workspaceId })
      if (pythonRuntimeRequestRef.current === requestId) {
        setPythonRuntime({ runtime, checking: false, error: null })
      }
    } catch (cause) {
      if (pythonRuntimeRequestRef.current === requestId) {
        setPythonRuntime({
          runtime: null,
          checking: false,
          error: `Could not detect Python environment: ${String(cause)}`,
        })
      }
    }
  }, [client, workspaceId])

  // Cache one full runtime result for this workspace while Python editing
  // remains active. Leaving Python and returning triggers a fresh resolution.
  useEffect(() => {
    const pythonActive = activeRelPath !== null && isPythonPath(activeRelPath)
    const shouldResolve =
      pythonActive &&
      (!wasPythonActiveRef.current || pythonRuntimeWorkspaceRef.current !== workspaceId)
    wasPythonActiveRef.current = pythonActive
    if (shouldResolve) {
      pythonRuntimeWorkspaceRef.current = workspaceId
      void refreshPythonRuntime()
    }
  }, [activeRelPath, refreshPythonRuntime, workspaceId])

  // While a Python file stays open without an environment, cheaply check only
  // the usual workspace directories. This notices a newly-created `.venv`
  // without repeatedly running manager/PATH probes.
  useEffect(() => {
    const pythonActive = activeRelPath !== null && isPythonPath(activeRelPath)
    if (!pythonActive || pythonRuntime.runtime?.source !== null || pythonRuntime.checking) return
    const id = window.setInterval(() => {
      if (pythonLocalCheckInFlightRef.current) return
      pythonLocalCheckInFlightRef.current = true
      const requestId = pythonRuntimeRequestRef.current
      void client.python.resolveLocal
        .query({ workspaceId })
        .then((runtime) => {
          if (runtime && pythonRuntimeRequestRef.current === requestId) {
            setPythonRuntime({ runtime, checking: false, error: null })
          }
        })
        .catch((cause) => {
          if (pythonRuntimeRequestRef.current === requestId) {
            setPythonRuntime((current) => ({
              ...current,
              error: `Could not recheck Python environment: ${String(cause)}`,
            }))
          }
        })
        .finally(() => {
          pythonLocalCheckInFlightRef.current = false
        })
    }, PYTHON_ENV_RECHECK_MS)
    return () => window.clearInterval(id)
  }, [activeRelPath, client, pythonRuntime.checking, pythonRuntime.runtime?.source, workspaceId])

  const listPythonEnvironments = useCallback(
    () => client.python.options.query({ workspaceId }),
    [client, workspaceId],
  )

  const selectPythonEnvironment = useCallback(
    async (path: string | null): Promise<boolean> => {
      pythonRuntimeRequestRef.current += 1
      const requestId = pythonRuntimeRequestRef.current
      setPythonRuntime((current) => ({ ...current, checking: true, error: null }))
      try {
        const runtime = await client.python.select.mutate({ workspaceId, path })
        if (pythonRuntimeRequestRef.current === requestId) {
          setPythonRuntime({ runtime, checking: false, error: null })
        }
        return true
      } catch (cause) {
        if (pythonRuntimeRequestRef.current === requestId) {
          setPythonRuntime((current) => ({
            ...current,
            checking: false,
            error: `Could not select Python environment: ${String(cause)}`,
          }))
        }
        return false
      }
    },
    [client, workspaceId],
  )

  const choosePythonEnvironment = useCallback(
    async (kind: "directory" | "interpreter"): Promise<boolean> => {
      const path =
        kind === "directory"
          ? await client.system.pickDirectory.mutate()
          : await client.system.pickFile.mutate()
      if (!path) return true
      return selectPythonEnvironment(path)
    },
    [client, selectPythonEnvironment],
  )

  // Poll the active file's fingerprint to spot agent/git edits.
  useEffect(() => {
    const id = window.setInterval(() => {
      const relPath = activeRef.current
      if (!relPath) return
      const buffer = buffersRef.current.find((b) => b.relPath === relPath)
      if (!buffer || externalCheckRef.current) return
      externalCheckRef.current = true
      void reload(buffer, false).finally(() => {
        externalCheckRef.current = false
      })
    }, STAT_POLL_MS)
    return () => window.clearInterval(id)
  }, [reload])

  // Autosave: persist a dirty active buffer after a short keystroke debounce.
  const autosave = settings.autosave
  const activeContent = active?.content ?? null
  const activeSavedContent = active?.savedContent ?? null
  useEffect(() => {
    if (!autosave || !activeRelPath || active?.externalChange) return
    if (activeContent === null || activeContent === activeSavedContent) return
    const id = window.setTimeout(() => {
      void saveFile(activeRelPath)
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [autosave, activeRelPath, activeContent, activeSavedContent, active?.externalChange, saveFile])

  const onBlurCapture = useCallback(() => {
    if (!autosave) return
    const relPath = activeRef.current
    if (!relPath) return
    const buffer = buffersRef.current.find((b) => b.relPath === relPath)
    if (buffer && buffer.content !== buffer.savedContent) void saveFile(relPath)
  }, [autosave, saveFile])

  const tabs = buffers.map((buffer) => ({
    relPath: buffer.relPath,
    dirty: buffer.externalChange || buffer.content !== buffer.savedContent,
  }))

  const activeResult = active ? (diagnostics[active.relPath]?.result ?? null) : null
  const diagnosticsSource = useMemo<DiagnosticsSource | undefined>(() => {
    if (
      !settings.diagnosticsEnabled ||
      !activeRelPath ||
      !isPythonPath(activeRelPath) ||
      !activeResult
    ) {
      return undefined
    }
    const list = activeResult.diagnostics
    return (doc: string) => toCmDiagnostics(doc, list)
  }, [activeRelPath, activeResult, settings.diagnosticsEnabled])

  const activeDiagnostics =
    settings.diagnosticsEnabled && active
      ? (diagnostics[active.relPath] ?? EMPTY_DIAGNOSTICS)
      : EMPTY_DIAGNOSTICS
  const statusCounts = activeDiagnostics.result
    ? countDiagnostics(activeDiagnostics.result.diagnostics)
    : EMPTY_COUNTS
  const statusMissing = activeDiagnostics.result?.missing ?? []

  const rejectedRead = rejectedOpen ?? active?.rejectedRead ?? null
  const revealRejectedRead = useCallback(async (): Promise<void> => {
    if (!rejectedRead) return
    await client.files.reveal
      .mutate({ workspaceId, relPath: rejectedRead.relPath })
      .catch((cause: unknown) =>
        setError(`Could not reveal ${rejectedRead.relPath}: ${String(cause)}`),
      )
  }, [client, workspaceId, rejectedRead])

  return {
    bufferAccess,
    buffers,
    active,
    activeRelPath,
    setActiveRelPath,
    openFile,
    openUntitled,
    closeFile,
    onEdit,
    saveFile,
    overwriteFile,
    reloadFile,
    saveAs,
    error,
    rejectedRead,
    revealRejectedRead,
    tabs,
    diagnosticsSource,
    statusCounts,
    statusMissing,
    activeDiagnostics,
    pythonRuntime,
    listPythonEnvironments,
    selectPythonEnvironment,
    choosePythonEnvironment,
    onBlurCapture,
  }
}
