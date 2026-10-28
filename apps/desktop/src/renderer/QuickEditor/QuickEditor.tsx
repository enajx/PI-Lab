import type { ImportedEditorTheme } from "@pi-lab/local-db/editor-settings"
import type { FileStat } from "@pi-lab/workspace-fs"
import { Settings2 } from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import type { QuickEditTarget } from "../../shared/quickEdit"
import { CodeMirrorBuffer } from "../Editor/components/CodeMirrorBuffer"
import {
  editorVimChoicePending,
  settleEditorVimChoice,
  useEditorVimCache,
  useQuickEditorAutocomplete,
  useQuickEditorMarkdownMode,
  useQuickEditorRunPython,
  writeEditorVimChoice,
} from "../preferences/preferences"
import { useTheme } from "../providers/ThemeProvider"
import { QuickEditorStatusBar } from "./QuickEditorStatusBar"
import {
  closeQuickBuffer,
  markQuickBufferConflicted,
  markQuickBufferSaved,
  type QuickBuffer,
  readQuickBuffer,
  readUntitledDraft,
  subscribeQuickEditor,
  writeQuickBuffer,
  writeUntitledDraft,
} from "./quickEditorState"

const QuickPythonTerminal = lazy(() =>
  import("./QuickPythonTerminal").then((module) => ({ default: module.QuickPythonTerminal })),
)

interface QuickEditorProps {
  targetId?: string
  fullApp: boolean
  sidebarCollapsed?: boolean
  editorTheme?: string
  customEditorThemes?: ImportedEditorTheme[]
  saveInProject?: (content: string) => Promise<string | null>
}

function changed(first: FileStat, second: FileStat): boolean {
  return (
    first.exists !== second.exists || first.mtimeMs !== second.mtimeMs || first.size !== second.size
  )
}

/** Edit one OS-selected text file without waiting for a project workspace. */
export function QuickEditor({
  targetId,
  fullApp,
  sidebarCollapsed,
  editorTheme,
  customEditorThemes,
  saveInProject,
}: QuickEditorProps) {
  const { resolvedMode } = useTheme()
  const [vim] = useEditorVimCache()
  const [autocomplete] = useQuickEditorAutocomplete()
  const [runPythonEnabled] = useQuickEditorRunPython()
  const [defaultMarkdownMode] = useQuickEditorMarkdownMode()
  const [markdownMode, setMarkdownMode] = useState(defaultMarkdownMode)
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const bridge = window.piLab?.quickEdit
  const [buffer, setBuffer] = useState<QuickBuffer | null>(null)
  const [untitled, setUntitled] = useState(false)
  const [untitledContent, setUntitledContent] = useState(readUntitledDraft)
  const untitledRef = useRef(untitledContent)
  const saveUntitledResolver = useRef<((route: string | null) => void) | null>(null)
  const [saveLocationRequested, setSaveLocationRequested] = useState(false)
  const bufferRef = useRef<QuickBuffer | null>(null)
  const loadGeneration = useRef(0)
  const mounted = useRef(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [pendingOpen, setPendingOpen] = useState<QuickEditTarget | null>(null)
  const [untitledReplaceRequested, setUntitledReplaceRequested] = useState(false)
  const [pendingRoute, setPendingRoute] = useState<string | null>(null)
  const [shutdownRequest, setShutdownRequest] = useState<string | null>(null)
  const [fileCloseRequested, setFileCloseRequested] = useState(false)
  const readySent = useRef(false)
  const [pythonSession, setPythonSession] = useState<{
    sessionId: string
    targetId: string
    fileName: string
  } | null>(null)
  const pythonSessionRef = useRef<string | null>(null)
  const pythonRunPending = useRef(false)
  const pythonStopPending = useRef(false)
  const [pythonRunning, setPythonRunning] = useState(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      loadGeneration.current += 1
    }
  }, [])

  useEffect(() => {
    if (fullApp) return
    return bridge?.subscribeEditorVim((enabled) => {
      if (!editorVimChoicePending()) settleEditorVimChoice(enabled)
    })
  }, [bridge, fullApp])

  const update = useCallback((next: QuickBuffer): void => {
    bufferRef.current = next
    writeQuickBuffer(next)
    setBuffer(next)
  }, [])

  useEffect(
    () =>
      subscribeQuickEditor(() => {
        const current = bufferRef.current
        const latest = current ? readQuickBuffer(current.target.id) : null
        if (!latest || latest === current) return
        bufferRef.current = latest
        setBuffer(latest)
      }),
    [],
  )

  const reportReady = useCallback((): void => {
    if (readySent.current) return
    readySent.current = true
    bridge?.ready()
  }, [bridge])

  const load = useCallback(
    async (target: QuickEditTarget, generation: number): Promise<void> => {
      if (!bridge || !mounted.current || generation !== loadGeneration.current) return
      setMarkdownMode(defaultMarkdownMode)
      setUntitled(false)
      setError(null)
      const cached = readQuickBuffer(target.id)
      if (cached) {
        update(cached)
        return
      }
      const result = await bridge.read(target.id).catch((cause: unknown) => {
        if (mounted.current && generation === loadGeneration.current) {
          setError(`Could not open ${target.path}: ${String(cause)}`)
          reportReady()
        }
        return null
      })
      if (!mounted.current || generation !== loadGeneration.current) return
      if (!result) return
      if (result.status !== "text") {
        setError(
          result.status === "oversized"
            ? `${target.path} is larger than the editor's ${result.limit}-byte opening limit.`
            : result.status === "binary"
              ? `${target.path} is a binary file.`
              : `${target.path} does not exist.`,
        )
        reportReady()
        return
      }
      update({
        target,
        content: result.content,
        savedContent: result.content,
        baseline: result.baseline,
        epoch: 0,
        conflict: false,
      })
    },
    [bridge, defaultMarkdownMode, reportReady, update],
  )

  useEffect(() => {
    if (!bridge) {
      setError("The quick editor is unavailable.")
      return
    }
    let active = true
    const generation = ++loadGeneration.current
    void bridge
      .current()
      .then((target) => {
        if (!active || generation !== loadGeneration.current) return
        if (fullApp && !targetId) {
          setUntitled(true)
          reportReady()
          return
        }
        if (!target || (targetId && target.id !== targetId)) {
          setError("The requested file is no longer available.")
          reportReady()
          return
        }
        return load(target, generation)
      })
      .catch((cause: unknown) => {
        if (!active || generation !== loadGeneration.current) return
        setError(`Could not open file: ${String(cause)}`)
        reportReady()
      })
    return () => {
      active = false
      loadGeneration.current += 1
    }
  }, [bridge, fullApp, load, reportReady, targetId])

  const save = useCallback(
    async (overwrite: boolean): Promise<boolean> => {
      const current = bufferRef.current
      if (!bridge || !current || busyRef.current) return false
      if (current.content === current.savedContent && !current.conflict) return true
      if (current.conflict && !overwrite) {
        setError("The file changed on disk. Reload it or choose Overwrite disk.")
        return false
      }
      busyRef.current = true
      setBusy(true)
      setError(null)
      const result = await bridge
        .save(current.target.id, current.content, current.baseline, overwrite)
        .catch((cause: unknown) => {
          if (mounted.current && bufferRef.current?.target.id === current.target.id)
            setError(`Could not save ${current.target.path}: ${String(cause)}`)
          return null
        })
      busyRef.current = false
      setBusy(false)
      if (!result) return false
      const latest = readQuickBuffer(current.target.id)
      if (!latest) return false
      if (result.status === "conflict") {
        markQuickBufferConflicted(current.target.id)
        if (mounted.current && bufferRef.current?.target.id === current.target.id)
          setError("The file changed on disk. Reload it or choose Overwrite disk.")
        return false
      }
      markQuickBufferSaved(current.target.id, current.content, result.baseline)
      return latest.content === current.content
    },
    [bridge],
  )

  /** Stop the attached run when its pane closes or the file changes. */
  const closePythonTerminal = useCallback(async (): Promise<boolean> => {
    const sessionId = pythonSessionRef.current
    if (!sessionId || !bridge) return true
    if (pythonStopPending.current) return false
    pythonStopPending.current = true
    const stopped = await bridge.pythonKill(sessionId).then(
      () => true,
      (cause: unknown) => {
        setError(`Could not stop Python: ${String(cause)}`)
        return false
      },
    )
    pythonStopPending.current = false
    if (stopped && pythonSessionRef.current === sessionId) {
      pythonSessionRef.current = null
      setPythonSession(null)
    }
    return stopped
  }, [bridge])

  /** Save the current file, then start it with the selected Python environment. */
  const runPython = useCallback(async (): Promise<void> => {
    const current = bufferRef.current
    if (
      !runPythonEnabled ||
      !bridge ||
      !current ||
      !/\.py$/i.test(current.target.path) ||
      busyRef.current ||
      pythonRunPending.current
    )
      return
    pythonRunPending.current = true
    setPythonRunning(true)
    setError(null)
    try {
      if (!(await save(false))) return
      if (!(await closePythonTerminal())) return
      const result = await bridge.pythonRun(current.target.id, 80, 24)
      if (bufferRef.current?.target.id !== current.target.id) {
        await bridge.pythonKill(result.sessionId)
        return
      }
      pythonSessionRef.current = result.sessionId
      setPythonSession({
        sessionId: result.sessionId,
        targetId: current.target.id,
        fileName: current.target.path.split(/[/\\]/).pop() ?? current.target.path,
      })
    } catch (cause) {
      setError(`Could not run Python: ${String(cause)}`)
    } finally {
      pythonRunPending.current = false
      setPythonRunning(false)
    }
  }, [bridge, closePythonTerminal, runPythonEnabled, save])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key !== "Enter" ||
        !event.shiftKey ||
        !(event.metaKey || event.ctrlKey) ||
        !(event.target instanceof HTMLElement) ||
        !event.target.closest(".cm-content")
      )
        return
      event.preventDefault()
      event.stopPropagation()
      void runPython()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [runPython])

  useEffect(() => {
    if (pythonSession && pythonSession.targetId !== buffer?.target.id) void closePythonTerminal()
  }, [buffer?.target.id, closePythonTerminal, pythonSession])

  useEffect(
    () => () => {
      const sessionId = pythonSessionRef.current
      if (sessionId) void bridge?.pythonKill(sessionId)
    },
    [bridge],
  )

  /** Ask for the destination only when an Untitled document is saved. */
  const saveUntitled = useCallback((): Promise<string | null> => {
    if (saveUntitledResolver.current) return Promise.resolve(null)
    return new Promise((resolve) => {
      saveUntitledResolver.current = resolve
      setSaveLocationRequested(true)
    })
  }, [])

  const finishUntitledSave = useCallback((route: string | null): void => {
    if (route) {
      untitledRef.current = ""
      writeUntitledDraft("")
      setUntitledContent("")
      setUntitled(false)
    }
    saveUntitledResolver.current?.(route)
    saveUntitledResolver.current = null
    setSaveLocationRequested(false)
  }, [])

  /** Save to a registered project or a native path, then hand off to its editor. */
  const chooseUntitledLocation = async (choice: "project" | "anywhere"): Promise<void> => {
    if (busyRef.current) return
    setSaveLocationRequested(false)
    if (choice === "project") {
      if (!saveInProject) {
        setError("Project saving is unavailable.")
        finishUntitledSave(null)
        return
      }
      busyRef.current = true
      setBusy(true)
      setError(null)
      const content = untitledRef.current
      const route = await saveInProject(content).catch((cause: unknown) => {
        setError(`Could not save Untitled: ${String(cause)}`)
        return null
      })
      busyRef.current = false
      setBusy(false)
      finishUntitledSave(route)
      return
    }
    busyRef.current = true
    setBusy(true)
    setError(null)
    const content = untitledRef.current
    const result = await bridge?.saveUntitled(content).catch((cause: unknown) => {
      setError(`Could not save Untitled: ${String(cause)}`)
      return null
    })
    busyRef.current = false
    setBusy(false)
    finishUntitledSave(result?.route ?? null)
  }

  const saveUntitledAndOpen = async (): Promise<void> => {
    const route = await saveUntitled()
    if (route) window.location.hash = `#${route}`
  }

  const reload = useCallback(async (): Promise<void> => {
    const current = bufferRef.current
    if (!bridge || !current) return
    const result = await bridge.read(current.target.id).catch((cause: unknown) => {
      if (mounted.current && bufferRef.current?.target.id === current.target.id)
        setError(`Could not reload ${current.target.path}: ${String(cause)}`)
      return null
    })
    if (!mounted.current) return
    const latest = bufferRef.current
    if (!latest || latest.target.id !== current.target.id) return
    if (latest !== current) {
      update({ ...latest, conflict: true })
      setError("The file changed on disk. Reload it or choose Overwrite disk.")
      return
    }
    if (result?.status !== "text") {
      if (result) setError("The file cannot be reloaded as text.")
      return
    }
    update({
      ...current,
      content: result.content,
      savedContent: result.content,
      baseline: result.baseline,
      conflict: false,
      epoch: current.epoch + 1,
    })
    setError(null)
  }, [bridge, update])

  const activeTargetId = buffer?.target.id
  useEffect(() => {
    if (!bridge || !activeTargetId) return
    const timer = window.setInterval(() => {
      const current = bufferRef.current
      if (!current || busyRef.current) return
      void bridge
        .stat(current.target.id)
        .then((disk) => {
          const latest = bufferRef.current
          if (!latest || latest.target.id !== current.target.id || !changed(latest.baseline, disk))
            return
          if (latest.content !== latest.savedContent) {
            update({ ...latest, conflict: true })
            return
          }
          void reload()
        })
        .catch((cause: unknown) => setError(`Could not check file: ${String(cause)}`))
    }, 1_500)
    return () => window.clearInterval(timer)
  }, [activeTargetId, bridge, reload, update])

  useEffect(() => {
    if (!bridge) return
    return bridge.subscribeOpen((target) => {
      const generation = ++loadGeneration.current
      setPendingOpen(null)
      setPendingRoute(null)
      setUntitledReplaceRequested(false)
      const current = bufferRef.current
      if (current?.target.id === target.id) return
      if (!current && untitledRef.current !== "") {
        setPendingOpen(target)
        setUntitledReplaceRequested(true)
        return
      }
      const move = async (): Promise<void> => {
        if (current?.content !== current?.savedContent && !(await save(false))) {
          if (!mounted.current || generation !== loadGeneration.current) return
          setPendingOpen(target)
          setError("Save or resolve this file before opening the next one.")
          return
        }
        if (!mounted.current || generation !== loadGeneration.current) return
        setPendingOpen(null)
        await load(target, generation)
        if (fullApp && mounted.current && generation === loadGeneration.current)
          window.location.hash = `#/quick-edit?target=${encodeURIComponent(target.id)}`
      }
      void move()
    })
  }, [bridge, fullApp, load, save])

  /** Resolve an Open File request without hiding a dirty Untitled document. */
  const replaceUntitled = async (choice: "save" | "discard" | "cancel"): Promise<void> => {
    const target = pendingOpen
    const generation = loadGeneration.current
    if (!target) return
    if (choice === "cancel") {
      setPendingOpen(null)
      setUntitledReplaceRequested(false)
      return
    }
    if (choice === "save") {
      const route = await saveUntitled()
      if (!mounted.current || generation !== loadGeneration.current) return
      if (!route) {
        setPendingOpen(null)
        setUntitledReplaceRequested(false)
        return
      }
    }
    if (choice === "discard") {
      untitledRef.current = ""
      writeUntitledDraft("")
      setUntitledContent("")
    }
    setPendingOpen(null)
    setUntitledReplaceRequested(false)
    await load(target, generation)
    if (fullApp && mounted.current && generation === loadGeneration.current)
      window.location.hash = `#/quick-edit?target=${encodeURIComponent(target.id)}`
  }

  useEffect(() => {
    if (!pendingOpen || !buffer || busy || buffer.content !== buffer.savedContent) return
    const generation = loadGeneration.current
    setPendingOpen(null)
    void load(pendingOpen, generation).then(() => {
      if (fullApp && mounted.current && generation === loadGeneration.current)
        window.location.hash = `#/quick-edit?target=${encodeURIComponent(pendingOpen.id)}`
    })
  }, [buffer, busy, fullApp, load, pendingOpen])

  useEffect(() => {
    if (!fullApp || !bridge) return
    return bridge.subscribeRoute((route) => {
      const generation = ++loadGeneration.current
      setPendingOpen(null)
      setPendingRoute(null)
      setUntitledReplaceRequested(false)
      const move = async (): Promise<void> => {
        const current = bufferRef.current
        if (current?.content !== current?.savedContent && !(await save(false))) {
          if (!mounted.current || generation !== loadGeneration.current) return
          setPendingRoute(route)
          setError("Save or resolve this file before opening the project file.")
          return
        }
        if (!mounted.current || generation !== loadGeneration.current) return
        window.location.hash = `#${route}`
      }
      void move()
    })
  }, [bridge, fullApp, save])

  useEffect(() => {
    if (!pendingRoute || !buffer || busy || buffer.content !== buffer.savedContent) return
    setPendingRoute(null)
    window.location.hash = `#${pendingRoute}`
  }, [buffer, busy, pendingRoute])

  useEffect(() => {
    const shutdown = window.piLab?.shutdown
    if (!shutdown) return
    return shutdown.subscribe((request) => {
      const current = bufferRef.current
      if ((!current || current.content === current.savedContent) && untitledRef.current === "") {
        shutdown.respond({ requestId: request.requestId, allow: true })
        return
      }
      setShutdownRequest(request.requestId)
    })
  }, [])

  const openFullApp = async (): Promise<void> => {
    const current = bufferRef.current
    if (!bridge || !current) return
    if (current.content !== current.savedContent && !(await save(false))) return
    await bridge.showFull(current.target.id).catch((cause: unknown) => {
      setError(`Could not open PI Lab: ${String(cause)}`)
    })
  }

  /** Save the file before replacing quick edit with its full Settings page. */
  const openQuickSettings = async (): Promise<void> => {
    const current = bufferRef.current
    if (!bridge) return
    if (current && current.content !== current.savedContent && !(await save(false))) return
    await bridge.showSettings(current?.target.id ?? null).catch((cause: unknown) => {
      setError(`Could not open Quick Editor settings: ${String(cause)}`)
    })
  }

  /** Use the app's existing native picker for a file outside or inside a project. */
  const openFile = async (): Promise<void> => {
    await window.piLab?.backgroundTray?.openFile().catch((cause: unknown) => {
      setError(`Could not open file: ${String(cause)}`)
    })
  }

  /** Close the full-app file only after the requested disk action succeeds. */
  const closeFile = useCallback(
    async (choice: "save" | "discard"): Promise<void> => {
      const current = bufferRef.current
      if (untitled && !current) {
        if (choice === "save") {
          const route = await saveUntitled()
          if (!route) {
            setFileCloseRequested(false)
            return
          }
          setFileCloseRequested(false)
          window.location.hash = `#${route}`
          return
        }
        untitledRef.current = ""
        writeUntitledDraft("")
        setUntitledContent("")
        setFileCloseRequested(false)
        window.location.hash = "#/"
        return
      }
      if (!bridge || !current || busyRef.current) return
      if (choice === "save" && !(await save(false))) {
        setFileCloseRequested(false)
        return
      }
      busyRef.current = true
      setBusy(true)
      const closed = await bridge.close(current.target.id).then(
        () => true,
        (cause: unknown) => {
          setError(`Could not close ${current.target.path}: ${String(cause)}`)
          return false
        },
      )
      busyRef.current = false
      setBusy(false)
      if (!closed) return
      closeQuickBuffer(current.target.id)
      bufferRef.current = null
      setBuffer(null)
      setFileCloseRequested(false)
      window.location.hash = "#/"
    },
    [bridge, save, saveUntitled, untitled],
  )

  const requestFileClose = useCallback((): void => {
    const current = bufferRef.current
    if (!fullApp || busyRef.current || fileCloseRequested) return
    if (!current) {
      if (untitled && untitledRef.current !== "") {
        setFileCloseRequested(true)
        return
      }
      if (untitled) window.location.hash = "#/"
      return
    }
    if (current.content !== current.savedContent) {
      setFileCloseRequested(true)
      return
    }
    void closeFile("discard")
  }, [closeFile, fileCloseRequested, fullApp, untitled])

  useEffect(() => {
    if (!fullApp) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "w" || !event.ctrlKey || event.metaKey) return
      event.preventDefault()
      event.stopPropagation()
      requestFileClose()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [fullApp, requestFileClose])

  const resolveShutdown = async (choice: "save" | "discard" | "cancel"): Promise<void> => {
    const requestId = shutdownRequest
    if (!requestId) return
    if (choice === "save") {
      if (untitled && untitledRef.current !== "") {
        if (!(await saveUntitled())) return
      } else if (bufferRef.current && !(await save(false))) return
    }
    window.piLab?.shutdown.respond({ requestId, allow: choice !== "cancel" })
    setShutdownRequest(null)
  }

  const active = buffer
  const dirty = active !== null ? active.content !== active.savedContent : untitledContent !== ""
  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-background text-foreground"
      data-testid={fullApp ? "quick-editor-full-app" : "quick-editor"}
    >
      <header
        className={`flex min-h-12 shrink-0 items-center gap-3 border-b ${
          fullApp ? (sidebarCollapsed ? "app-drag pl-20 pr-6" : "px-6") : "app-drag pl-24 pr-4"
        }`}
      >
        {fullApp ? (
          <div className="flex min-w-0 flex-1 items-baseline gap-3" title={active?.target.path}>
            <h1 className="shrink-0 font-semibold text-foreground text-sm tracking-tight">
              Editor
            </h1>
            {active || untitled ? (
              <span
                className="truncate text-muted-foreground text-sm"
                data-testid="quick-editor-header-filename"
              >
                {active ? active.target.path.split(/[/\\]/).pop() : "Untitled"}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-baseline gap-4">
            <h1 className="shrink-0 font-semibold text-sm">PI Lab Editor</h1>
            {active ? (
              <span
                className="min-w-0 truncate text-muted-foreground text-sm"
                data-testid="quick-editor-path"
                title={active.target.path}
              >
                {active.target.path}
              </span>
            ) : null}
          </div>
        )}
        <button
          type="button"
          className={`rounded border px-3 py-1 text-sm disabled:opacity-50 ${
            !fullApp || sidebarCollapsed ? "app-no-drag" : ""
          }`}
          disabled={(!active && !untitled) || busy || (active !== null && !dirty)}
          onClick={() => void (untitled ? saveUntitledAndOpen() : save(false))}
        >
          Save
        </button>
        {runPythonEnabled && active && /\.py$/i.test(active.target.path) ? (
          <button
            type="button"
            data-testid="quick-python-run"
            className={`rounded border px-3 py-1 text-sm disabled:opacity-50 ${
              !fullApp || sidebarCollapsed ? "app-no-drag" : ""
            }`}
            disabled={busy || pythonRunning}
            onClick={() => void runPython()}
          >
            {pythonRunning ? "Running…" : "Run"}
          </button>
        ) : null}
        {fullApp ? (
          <button
            type="button"
            className="rounded border px-3 py-1 text-sm"
            onClick={() => void openFile()}
          >
            Open File
          </button>
        ) : null}
        {!fullApp ? (
          <button
            type="button"
            data-testid="quick-editor-settings"
            aria-label="Quick Editor settings"
            title="Quick Editor settings"
            className="app-no-drag rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            disabled={busy}
            onClick={() => void openQuickSettings()}
          >
            <Settings2 aria-hidden className="size-4" />
          </button>
        ) : null}
        {!fullApp ? (
          <button
            type="button"
            className="app-no-drag rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50"
            disabled={!active || busy}
            onClick={() => void openFullApp()}
          >
            Open PI Lab
          </button>
        ) : null}
      </header>
      {fullApp && (active || untitled) ? (
        <div className="flex min-h-9 items-end border-b bg-muted/30 px-2">
          <div
            className="flex h-8 max-w-64 items-center gap-2 rounded-t-md border border-b-0 bg-background px-3 text-sm"
            data-testid="quick-editor-tab"
            title={active?.target.path ?? "Untitled"}
          >
            <span className="min-w-0 truncate">
              {active?.target.path.split(/[/\\]/).pop() ?? "Untitled"}
            </span>
            {dirty ? (
              <span title="Unsaved changes" className="text-muted-foreground">
                ●
              </span>
            ) : null}
            <button
              type="button"
              aria-label="Close file"
              className="rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              data-testid="quick-editor-tab-close"
              onClick={requestFileClose}
            >
              ×
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="flex items-center gap-3 border-b px-4 py-2 text-sm">
          <span className="flex-1">{error}</span>
          {active?.conflict ? (
            <>
              <button type="button" onClick={() => void reload()}>
                Reload disk
              </button>
              <button type="button" onClick={() => void save(true)}>
                Overwrite disk
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {pendingOpen ? (
        <div role="status" className="border-b px-4 py-2 text-sm">
          Waiting to open {pendingOpen.path}
        </div>
      ) : null}
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        data-testid="quick-editor-content"
      >
        {active ? (
          <CodeMirrorBuffer
            autoFocus
            key={`${active.target.id}:${active.epoch}`}
            relPath={active.target.path}
            initialDoc={active.content}
            theme={
              editorTheme && editorTheme !== "default" ? editorTheme : `pi-lab-${resolvedMode}`
            }
            customThemes={customEditorThemes}
            vim={vim}
            autocomplete={autocomplete ? "words" : false}
            markdownMode={markdownMode}
            onCursorChange={(line, column) => setCursor({ line, column })}
            onChange={(content) => {
              const current = bufferRef.current
              if (current) update({ ...current, content })
            }}
            onSave={() => void save(false)}
            onRun={fullApp ? undefined : () => void openFullApp()}
            onReady={() => {
              performance.mark("pi-lab-quick-edit-caret-ready")
              reportReady()
            }}
          />
        ) : untitled ? (
          <CodeMirrorBuffer
            autoFocus
            key="untitled"
            relPath="Untitled"
            initialDoc={untitledContent}
            theme={
              editorTheme && editorTheme !== "default" ? editorTheme : `pi-lab-${resolvedMode}`
            }
            customThemes={customEditorThemes}
            vim={vim}
            autocomplete={autocomplete ? "words" : false}
            markdownMode={markdownMode}
            onCursorChange={(line, column) => setCursor({ line, column })}
            onChange={(content) => {
              untitledRef.current = content
              writeUntitledDraft(content)
              setUntitledContent(content)
            }}
            onSave={() => void saveUntitledAndOpen()}
            onReady={reportReady}
          />
        ) : (
          <div role="status" className="p-4 text-sm">
            {error ?? "Opening file…"}
          </div>
        )}
      </div>
      {pythonSession ? (
        <Suspense
          fallback={
            <div className="h-56 shrink-0 border-border border-t p-3 text-sm">
              Opening terminal…
            </div>
          }
        >
          <QuickPythonTerminal
            sessionId={pythonSession.sessionId}
            fileName={pythonSession.fileName}
            onClose={() => void closePythonTerminal()}
          />
        </Suspense>
      ) : null}
      {active || untitled ? (
        <QuickEditorStatusBar
          path={active?.target.path ?? "Untitled"}
          line={cursor.line}
          column={cursor.column}
          vim={vim}
          onVimChange={writeEditorVimChoice}
          markdownMode={markdownMode}
          onMarkdownModeChange={setMarkdownMode}
          pythonTargetId={
            active && /\.py$/i.test(active.target.path) ? active.target.id : undefined
          }
        />
      ) : null}
      {saveLocationRequested ? (
        <div
          role="dialog"
          aria-label="Save Untitled"
          aria-modal="true"
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/60"
        >
          <div className="rounded border bg-background p-5 shadow-lg">
            <p className="mb-4 text-sm">Where would you like to save this file?</p>
            <div className="flex gap-3 text-sm">
              <button type="button" onClick={() => void chooseUntitledLocation("project")}>
                Save in project
              </button>
              <button type="button" onClick={() => void chooseUntitledLocation("anywhere")}>
                Save to any path
              </button>
              <button type="button" onClick={() => finishUntitledSave(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {fileCloseRequested ? (
        <div
          role="dialog"
          aria-label="Close editor file"
          aria-modal="true"
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/60"
        >
          <div className="rounded border bg-background p-5 shadow-lg">
            <p className="mb-4 text-sm">Save changes before closing this file?</p>
            <div className="flex gap-3 text-sm">
              <button type="button" disabled={busy} onClick={() => void closeFile("save")}>
                Save
              </button>
              <button type="button" disabled={busy} onClick={() => void closeFile("discard")}>
                Discard
              </button>
              <button type="button" disabled={busy} onClick={() => setFileCloseRequested(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {untitledReplaceRequested ? (
        <div
          role="dialog"
          aria-label="Open file over Untitled"
          aria-modal="true"
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/60"
        >
          <div className="rounded border bg-background p-5 shadow-lg">
            <p className="mb-4 text-sm">Save Untitled before opening another file?</p>
            <div className="flex gap-3 text-sm">
              <button type="button" disabled={busy} onClick={() => void replaceUntitled("save")}>
                Save
              </button>
              <button type="button" disabled={busy} onClick={() => void replaceUntitled("discard")}>
                Discard
              </button>
              <button type="button" disabled={busy} onClick={() => void replaceUntitled("cancel")}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {shutdownRequest ? (
        <div
          role="dialog"
          aria-label="Unsaved quick edit"
          className="absolute inset-0 flex items-center justify-center bg-black/60"
        >
          <div className="rounded border bg-background p-5">
            <p className="mb-4">Save changes before closing?</p>
            <div className="flex gap-3">
              <button type="button" onClick={() => void resolveShutdown("save")}>
                Save
              </button>
              <button type="button" onClick={() => void resolveShutdown("discard")}>
                Discard
              </button>
              <button type="button" onClick={() => void resolveShutdown("cancel")}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
