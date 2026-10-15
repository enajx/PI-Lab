import type { ImportedEditorTheme } from "@pi-lab/local-db/editor-settings"
import type { FileStat } from "@pi-lab/workspace-fs"
import { useCallback, useEffect, useRef, useState } from "react"
import type { QuickEditTarget } from "../../shared/quickEdit"
import { CodeMirrorBuffer } from "../Editor/components/CodeMirrorBuffer"
import { useTheme } from "../providers/ThemeProvider"
import {
  closeQuickBuffer,
  type QuickBuffer,
  readQuickBuffer,
  writeQuickBuffer,
} from "./quickEditorState"

interface QuickEditorProps {
  targetId?: string
  fullApp: boolean
  sidebarCollapsed?: boolean
  editorTheme?: string
  customEditorThemes?: ImportedEditorTheme[]
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
}: QuickEditorProps) {
  const { resolvedMode } = useTheme()
  const bridge = window.piLab?.quickEdit
  const [buffer, setBuffer] = useState<QuickBuffer | null>(null)
  const bufferRef = useRef<QuickBuffer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [pendingOpen, setPendingOpen] = useState<QuickEditTarget | null>(null)
  const [pendingRoute, setPendingRoute] = useState<string | null>(null)
  const [shutdownRequest, setShutdownRequest] = useState<string | null>(null)
  const [fileCloseRequested, setFileCloseRequested] = useState(false)
  const readySent = useRef(false)

  const update = useCallback((next: QuickBuffer): void => {
    bufferRef.current = next
    writeQuickBuffer(next)
    setBuffer(next)
  }, [])

  const reportReady = useCallback((): void => {
    if (readySent.current) return
    readySent.current = true
    bridge?.ready()
  }, [bridge])

  const load = useCallback(
    async (target: QuickEditTarget): Promise<void> => {
      if (!bridge) return
      setError(null)
      const cached = readQuickBuffer(target.id)
      if (cached) {
        update(cached)
        return
      }
      const result = await bridge.read(target.id)
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
    [bridge, reportReady, update],
  )

  useEffect(() => {
    if (!bridge) {
      setError("The quick editor is unavailable.")
      return
    }
    let active = true
    void bridge
      .current()
      .then((target) => {
        if (!active) return
        if (!target || (targetId && target.id !== targetId)) {
          setError("The requested file is no longer available.")
          reportReady()
          return
        }
        return load(target)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setError(`Could not open file: ${String(cause)}`)
        reportReady()
      })
    return () => {
      active = false
    }
  }, [bridge, load, reportReady, targetId])

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
          setError(`Could not save ${current.target.path}: ${String(cause)}`)
          return null
        })
      busyRef.current = false
      setBusy(false)
      if (!result) return false
      const latest = bufferRef.current
      if (!latest || latest.target.id !== current.target.id) return false
      if (result.status === "conflict") {
        update({ ...latest, conflict: true })
        setError("The file changed on disk. Reload it or choose Overwrite disk.")
        return false
      }
      const next = {
        ...latest,
        savedContent: current.content,
        baseline: result.baseline,
        conflict: false,
      }
      update(next)
      return next.content === next.savedContent
    },
    [bridge, update],
  )

  const reload = useCallback(async (): Promise<void> => {
    const current = bufferRef.current
    if (!bridge || !current) return
    const result = await bridge.read(current.target.id).catch((cause: unknown) => {
      setError(`Could not reload ${current.target.path}: ${String(cause)}`)
      return null
    })
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
      const current = bufferRef.current
      if (current?.target.id === target.id) return
      const move = async (): Promise<void> => {
        if (current?.content !== current?.savedContent && !(await save(false))) {
          setPendingOpen(target)
          setError("Save or resolve this file before opening the next one.")
          return
        }
        setPendingOpen(null)
        await load(target)
        if (fullApp) window.location.hash = `#/quick-edit?target=${encodeURIComponent(target.id)}`
      }
      void move()
    })
  }, [bridge, fullApp, load, save])

  useEffect(() => {
    if (!pendingOpen || !buffer || busy || buffer.content !== buffer.savedContent) return
    setPendingOpen(null)
    void load(pendingOpen)
    if (fullApp) window.location.hash = `#/quick-edit?target=${encodeURIComponent(pendingOpen.id)}`
  }, [buffer, busy, fullApp, load, pendingOpen])

  useEffect(() => {
    if (!fullApp || !bridge) return
    return bridge.subscribeRoute((route) => {
      const move = async (): Promise<void> => {
        const current = bufferRef.current
        if (current?.content !== current?.savedContent && !(await save(false))) {
          setPendingRoute(route)
          setError("Save or resolve this file before opening the project file.")
          return
        }
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
      if (bufferRef.current?.content === bufferRef.current?.savedContent) {
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

  /** Close the full-app file only after the requested disk action succeeds. */
  const closeFile = useCallback(
    async (choice: "save" | "discard"): Promise<void> => {
      const current = bufferRef.current
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
    [bridge, save],
  )

  const requestFileClose = useCallback((): void => {
    const current = bufferRef.current
    if (!fullApp || !current || busyRef.current || fileCloseRequested) return
    if (current.content !== current.savedContent) {
      setFileCloseRequested(true)
      return
    }
    void closeFile("discard")
  }, [closeFile, fileCloseRequested, fullApp])

  useEffect(() => {
    if (!fullApp) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "w" || !(event.metaKey || event.ctrlKey)) return
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
    if (choice === "save" && !(await save(false))) return
    window.piLab?.shutdown.respond({ requestId, allow: choice !== "cancel" })
    setShutdownRequest(null)
  }

  const active = buffer
  const dirty = active !== null && active.content !== active.savedContent
  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-background text-foreground"
      data-testid={fullApp ? "quick-editor-full-app" : "quick-editor"}
    >
      <header
        className={`flex min-h-12 items-center gap-3 border-b ${
          fullApp ? (sidebarCollapsed ? "app-drag pl-20 pr-6" : "px-6") : "px-4 pl-20"
        }`}
      >
        {fullApp ? (
          <div className="flex min-w-0 flex-1 items-baseline gap-3" title={active?.target.path}>
            <h1 className="shrink-0 font-semibold text-foreground text-sm tracking-tight">
              Editor
            </h1>
            {active ? (
              <span
                className="truncate text-muted-foreground text-sm"
                data-testid="quick-editor-header-filename"
              >
                {active.target.path.split(/[/\\]/).pop()}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="min-w-0 flex-1 truncate text-sm" title={active?.target.path}>
            {active ? `${active.target.path}${dirty ? " •" : ""}` : "Quick edit"}
          </div>
        )}
        <button
          type="button"
          className={`rounded border px-3 py-1 text-sm disabled:opacity-50 ${
            fullApp && sidebarCollapsed ? "app-no-drag" : ""
          }`}
          disabled={!active || busy || !dirty}
          onClick={() => void save(false)}
        >
          Save
        </button>
        {!fullApp ? (
          <button
            type="button"
            className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50"
            disabled={!active || busy}
            onClick={() => void openFullApp()}
          >
            Open PI Lab
          </button>
        ) : null}
      </header>
      {fullApp && active ? (
        <div className="flex min-h-9 items-end border-b bg-muted/30 px-2">
          <div
            className="flex h-8 max-w-64 items-center gap-2 rounded-t-md border border-b-0 bg-background px-3 text-sm"
            data-testid="quick-editor-tab"
            title={active.target.path}
          >
            <span className="min-w-0 truncate">{active.target.path.split(/[/\\]/).pop()}</span>
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
      <div className="min-h-0 flex-1" data-testid="quick-editor-content">
        {active ? (
          <CodeMirrorBuffer
            key={`${active.target.id}:${active.epoch}`}
            relPath={active.target.path}
            initialDoc={active.content}
            theme={
              editorTheme && editorTheme !== "default" ? editorTheme : `pi-lab-${resolvedMode}`
            }
            customThemes={customEditorThemes}
            onChange={(content) => {
              const current = bufferRef.current
              if (current) update({ ...current, content })
            }}
            onSave={() => void save(false)}
            onReady={() => {
              performance.mark("pi-lab-quick-edit-caret-ready")
              reportReady()
            }}
          />
        ) : (
          <div role="status" className="p-4 text-sm">
            {error ?? "Opening file…"}
          </div>
        )}
      </div>
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
