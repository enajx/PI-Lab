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

/** A file's fingerprint on disk at the moment we last read it. */
interface DiskBaseline {
  mtimeMs: number
  size: number
}

/** In-memory state for one open file. */
export interface OpenBuffer {
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
}

export interface EditorBuffersApi {
  buffers: OpenBuffer[]
  active: OpenBuffer | null
  activeRelPath: string | null
  setActiveRelPath: (relPath: string | null) => void
  /** Open a file (or focus it if already open) and make it the active buffer. */
  openFile: (relPath: string) => Promise<void>
  closeFile: (relPath: string) => void
  onEdit: (relPath: string, content: string) => void
  saveFile: (relPath: string) => Promise<boolean>
  error: string | null
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
 * the fake client (md/engineering/testing-and-build.md).
 */
export function useEditorBuffers({
  client,
  workspaceId,
  settings,
  onSaved,
  initialBuffers,
  initialActiveRelPath,
}: UseEditorBuffersArgs): EditorBuffersApi {
  const [buffers, setBuffers] = useState<OpenBuffer[]>(() => initialBuffers ?? [])
  const [activeRelPath, setActiveRelPath] = useState<string | null>(
    () => initialActiveRelPath ?? null,
  )
  const [error, setError] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<Record<string, DiagnosticsState>>({})
  const [pythonRuntime, setPythonRuntime] = useState<PythonRuntimeState>(EMPTY_PYTHON_RUNTIME)

  const buffersRef = useRef(buffers)
  buffersRef.current = buffers
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
      const existing = buffersRef.current.find((buffer) => buffer.relPath === relPath)
      if (existing) {
        setActiveRelPath(relPath)
        return
      }
      try {
        const [read, stat] = await Promise.all([
          client.files.read.query({ workspaceId, relPath }),
          client.files.stat.query({ workspaceId, relPath }),
        ])
        const content = read.content
        setBuffers((prev) => {
          if (prev.some((buffer) => buffer.relPath === relPath)) return prev
          return [
            ...prev,
            {
              relPath,
              content,
              savedContent: content,
              baseline: { mtimeMs: stat.mtimeMs, size: stat.size },
              externalChange: false,
              epoch: 0,
            },
          ]
        })
        setActiveRelPath(relPath)
        void runDiagnostics(relPath)
      } catch (cause) {
        setError(`Could not open ${relPath}: ${String(cause)}`)
      }
    },
    [client, workspaceId, runDiagnostics],
  )

  const closeFile = useCallback((relPath: string) => {
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
  }, [])

  const onEdit = useCallback((relPath: string, content: string) => {
    setBuffers((prev) =>
      prev.map((buffer) => (buffer.relPath === relPath ? { ...buffer, content } : buffer)),
    )
  }, [])

  const saveFile = useCallback(
    async (relPath: string) => {
      const buffer = buffersRef.current.find((b) => b.relPath === relPath)
      if (!buffer) return false
      setError(null)
      try {
        await client.files.write.mutate({ workspaceId, relPath, content: buffer.content })

        let reloaded = false
        if (formatOnSaveRef.current && isPythonPath(relPath)) {
          const format = await client.diagnostics.format.mutate({ workspaceId, relPath })
          if (format.changed) {
            const read = await client.files.read.query({ workspaceId, relPath })
            const stat = await client.files.stat.query({ workspaceId, relPath })
            setBuffers((prev) =>
              prev.map((b) =>
                b.relPath === relPath
                  ? {
                      ...b,
                      content: read.content,
                      savedContent: read.content,
                      baseline: { mtimeMs: stat.mtimeMs, size: stat.size },
                      externalChange: false,
                      epoch: b.epoch + 1,
                    }
                  : b,
              ),
            )
            reloaded = true
          }
        }

        if (!reloaded) {
          const stat = await client.files.stat.query({ workspaceId, relPath })
          setBuffers((prev) =>
            prev.map((b) =>
              b.relPath === relPath
                ? {
                    ...b,
                    savedContent: b.content,
                    baseline: { mtimeMs: stat.mtimeMs, size: stat.size },
                    externalChange: false,
                  }
                : b,
            ),
          )
        }

        onSaved?.(relPath)
        void runDiagnostics(relPath)
        return true
      } catch (cause) {
        setError(`Could not save ${relPath}: ${String(cause)}`)
        return false
      }
    },
    [client, workspaceId, onSaved, runDiagnostics],
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
      if (!buffer) return
      void reconcileExternal(client, workspaceId, buffer, setBuffers, runDiagnostics)
    }, STAT_POLL_MS)
    return () => window.clearInterval(id)
  }, [client, workspaceId, runDiagnostics])

  // Autosave: persist a dirty active buffer after a short keystroke debounce.
  const autosave = settings.autosave
  const activeContent = active?.content ?? null
  const activeSavedContent = active?.savedContent ?? null
  useEffect(() => {
    if (!autosave || !activeRelPath) return
    if (activeContent === null || activeContent === activeSavedContent) return
    const id = window.setTimeout(() => {
      void saveFile(activeRelPath)
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [autosave, activeRelPath, activeContent, activeSavedContent, saveFile])

  const onBlurCapture = useCallback(() => {
    if (!autosave) return
    const relPath = activeRef.current
    if (!relPath) return
    const buffer = buffersRef.current.find((b) => b.relPath === relPath)
    if (buffer && buffer.content !== buffer.savedContent) void saveFile(relPath)
  }, [autosave, saveFile])

  const tabs = buffers.map((buffer) => ({
    relPath: buffer.relPath,
    dirty: buffer.content !== buffer.savedContent,
  }))

  const activeResult = active ? (diagnostics[active.relPath]?.result ?? null) : null
  const diagnosticsSource = useMemo<DiagnosticsSource | undefined>(() => {
    if (!settings.diagnosticsEnabled || !active || !isPythonPath(active.relPath) || !activeResult) {
      return undefined
    }
    const list = activeResult.diagnostics
    return (doc: string) => toCmDiagnostics(doc, list)
  }, [active, activeResult, settings.diagnosticsEnabled])

  const activeDiagnostics =
    settings.diagnosticsEnabled && active
      ? (diagnostics[active.relPath] ?? EMPTY_DIAGNOSTICS)
      : EMPTY_DIAGNOSTICS
  const statusCounts = activeDiagnostics.result
    ? countDiagnostics(activeDiagnostics.result.diagnostics)
    : EMPTY_COUNTS
  const statusMissing = activeDiagnostics.result?.missing ?? []

  return {
    buffers,
    active,
    activeRelPath,
    setActiveRelPath,
    openFile,
    closeFile,
    onEdit,
    saveFile,
    error,
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

/**
 * Compare a buffer against its on-disk fingerprint and reconcile out-of-band
 * edits (never silently clobber). Unchanged ⇒ no-op. Changed + clean ⇒ reseed the
 * doc (bump `epoch` to remount the view). Changed + dirty ⇒ flag `externalChange`.
 */
async function reconcileExternal(
  client: PiLabTrpcClient,
  workspaceId: string,
  buffer: OpenBuffer,
  setBuffers: React.Dispatch<React.SetStateAction<OpenBuffer[]>>,
  runDiagnostics: (relPath: string) => Promise<void>,
): Promise<void> {
  const stat = await client.files.stat.query({ workspaceId, relPath: buffer.relPath })
  const changed = stat.mtimeMs !== buffer.baseline.mtimeMs || stat.size !== buffer.baseline.size
  if (!changed) return

  const dirty = buffer.content !== buffer.savedContent
  if (dirty) {
    setBuffers((prev) =>
      prev.map((b) => (b.relPath === buffer.relPath ? { ...b, externalChange: true } : b)),
    )
    return
  }

  const read = await client.files.read.query({ workspaceId, relPath: buffer.relPath })
  setBuffers((prev) =>
    prev.map((b) =>
      b.relPath === buffer.relPath
        ? {
            ...b,
            content: read.content,
            savedContent: read.content,
            baseline: { mtimeMs: stat.mtimeMs, size: stat.size },
            externalChange: false,
            epoch: b.epoch + 1,
          }
        : b,
    ),
  )
  void runDiagnostics(buffer.relPath)
}
