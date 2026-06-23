import type { EditorSettings } from "@skipper/local-db"
import { AlertTriangle } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { SkipperTrpcClient } from "../../../trpc/client"
import {
  countDiagnostics,
  type DiagnosticCounts,
  type DiagnosticsRunResult,
  isPythonPath,
  runPythonCheck,
  toCmDiagnostics,
} from "../../utils/pythonDiagnostics"
import { CodeMirrorBuffer, type DiagnosticsSource } from "../CodeMirrorBuffer"
import { EditorSettingsMenu } from "../EditorSettingsMenu"
import { EditorStatusBar } from "../EditorStatusBar"
import { EditorTabs } from "../EditorTabs"
import { FileTree } from "../FileTree"
import { QuickOpen } from "../QuickOpen"

interface EditorPaneProps {
  /** App-wide tRPC client used for imperative reads/writes and stat polling. */
  client: SkipperTrpcClient
  workspaceId: string
  /**
   * Live editor preferences (autosave / vim / type checker / format-on-save).
   * Read reactively by {@link Editor} so toggles take effect immediately. Falls
   * back to the spec defaults when no settings have been persisted yet.
   */
  editorSettings?: EditorSettings
  /**
   * Persist a patch to the editor preferences (wired to `settings.updateEditor`
   * by {@link Editor}). Drives the in-toolbar settings menu; omitted ⇒ the menu
   * renders read-only-ish (still mounted for layout but toggles no-op).
   */
  onUpdateEditorSettings?: (patch: Partial<EditorSettings>) => void
  onSaved?: (relPath: string) => void
}

/** A file's fingerprint on disk at the moment we last read it. */
interface DiskBaseline {
  mtimeMs: number
  size: number
}

/** In-memory state for one open file. */
interface OpenBuffer {
  relPath: string
  /** Live document text (what CodeMirror shows). */
  content: string
  /** Text last loaded from / saved to disk — the dirty comparison baseline. */
  savedContent: string
  /** Disk fingerprint at the last load/save, for external-change detection. */
  baseline: DiskBaseline
  /**
   * Set when the file changed on disk while this buffer was dirty — we surface a
   * non-destructive warning rather than clobbering the user's edits.
   */
  externalChange: boolean
  /**
   * Forces a fresh CodeMirror mount when bumped (after an external auto-reload):
   * the buffer view reads `content` only on mount, so a new key reseeds it.
   */
  epoch: number
}

/**
 * Per-file diagnostics state for the **active Python file** (TODO "Built-in
 * editor"). Diagnostics are a one-shot-on-save model: we (re)run `ty`/`ruff` on
 * open and after each successful save, cache the result here, and feed it to the
 * buffer's lint source + the status bar. Non-Python files never get an entry.
 */
interface DiagnosticsState {
  /** The last completed run's normalized result (squiggles + status counts). */
  result: DiagnosticsRunResult | null
  /** True while a check is in flight for this file. */
  checking: boolean
  /** True once a check has completed at least once for this file. */
  hasRun: boolean
}

const STAT_POLL_MS = 1_500
/** How long after the last keystroke autosave fires (spec: "short debounce"). */
const AUTOSAVE_DEBOUNCE_MS = 800

const DEFAULT_SETTINGS: EditorSettings = {
  autosave: false,
  vim: false,
  typeChecker: "ty",
  formatOnSave: false,
}

const EMPTY_DIAGNOSTICS: DiagnosticsState = { result: null, checking: false, hasRun: false }
const EMPTY_COUNTS: DiagnosticCounts = { errors: 0, warnings: 0, infos: 0 }

/**
 * Stateful editor core (AGENTS.md §7; spec: TODO "Built-in editor"). Owns the
 * set of open buffers, the active tab, save, external-change reconciliation, the
 * quick-open overlay, and — wired in the integrate stage — Python diagnostics,
 * the editor-settings menu, autosave, vim, and format-on-save. Reads/writes go
 * through the injected tRPC client so this is fully testable with the fake
 * client (AGENTS.md §14).
 *
 * Layout: a fixed-width file tree on the left, then a bounded editor column
 * (toolbar + tabs + buffer + status bar). Each region scrolls natively in its
 * own bounded box (AGENTS.md §12.3) — no Radix ScrollArea.
 */
export function EditorPane({
  client,
  workspaceId,
  editorSettings,
  onUpdateEditorSettings,
  onSaved,
}: EditorPaneProps) {
  const settings = editorSettings ?? DEFAULT_SETTINGS
  const [buffers, setBuffers] = useState<OpenBuffer[]>([])
  const [activeRelPath, setActiveRelPath] = useState<string | null>(null)
  const [quickOpen, setQuickOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Diagnostics keyed by file path — only the active Python file is ever populated.
  const [diagnostics, setDiagnostics] = useState<Record<string, DiagnosticsState>>({})

  // Latest buffers in a ref so the stat-poll interval and the ⌘P listener read
  // current state without re-subscribing on every keystroke.
  const buffersRef = useRef(buffers)
  buffersRef.current = buffers
  const activeRef = useRef(activeRelPath)
  activeRef.current = activeRelPath
  // The type checker the next diagnostics run should use — read from a ref so the
  // save handler (a stable callback) always picks up the current setting.
  const typeCheckerRef = useRef(settings.typeChecker)
  typeCheckerRef.current = settings.typeChecker
  const formatOnSaveRef = useRef(settings.formatOnSave)
  formatOnSaveRef.current = settings.formatOnSave

  const active = buffers.find((buffer) => buffer.relPath === activeRelPath) ?? null

  /** Patch one file's diagnostics state, leaving the others untouched. */
  const patchDiagnostics = useCallback((relPath: string, patch: Partial<DiagnosticsState>) => {
    setDiagnostics((prev) => ({
      ...prev,
      [relPath]: { ...(prev[relPath] ?? EMPTY_DIAGNOSTICS), ...patch },
    }))
  }, [])

  /**
   * (Re)run the one-shot Python check for a saved file and cache the result.
   * No-op for non-Python files. Failures (other than tooling absence, which the
   * router models as `toolsAvailable: false`) are swallowed so a diagnostics
   * hiccup never breaks editing — they just leave the prior result in place.
   */
  const runDiagnostics = useCallback(
    async (relPath: string) => {
      if (!isPythonPath(relPath)) return
      patchDiagnostics(relPath, { checking: true })
      try {
        const result = await runPythonCheck(client, {
          workspaceId,
          relPath,
          typeChecker: typeCheckerRef.current,
        })
        if (result) patchDiagnostics(relPath, { result, checking: false, hasRun: true })
        else patchDiagnostics(relPath, { checking: false })
      } catch {
        patchDiagnostics(relPath, { checking: false })
      }
    },
    [client, workspaceId, patchDiagnostics],
  )

  /** Open a file (or focus it if already open), reading its content + baseline. */
  const openFile = useCallback(
    async (relPath: string) => {
      setQuickOpen(false)
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
        // Diagnostics on open (against the on-disk content we just read).
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
      // When the active tab closes, fall back to the last remaining buffer (or
      // the empty state if none are left); other closures leave the active tab.
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

  /** Record a live edit; recomputes dirty against the saved baseline. */
  const onEdit = useCallback((relPath: string, content: string) => {
    setBuffers((prev) =>
      prev.map((buffer) => (buffer.relPath === relPath ? { ...buffer, content } : buffer)),
    )
  }, [])

  /**
   * Persist a buffer via `files.write`, then refresh its baseline + fingerprint.
   * When format-on-save is on, run `ruff format` on the freshly-saved file and,
   * if it rewrote the file, reload the buffer from disk (a remount via `epoch`).
   * After a successful save, re-run diagnostics against the new on-disk content.
   */
  const saveFile = useCallback(
    async (relPath: string) => {
      const buffer = buffersRef.current.find((b) => b.relPath === relPath)
      if (!buffer) return
      setError(null)
      try {
        await client.files.write.mutate({ workspaceId, relPath, content: buffer.content })

        // Format-on-save: ruff rewrites the file in place; reload only if it changed.
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
        // Refresh diagnostics against the just-saved (possibly formatted) content.
        void runDiagnostics(relPath)
      } catch (cause) {
        setError(`Could not save ${relPath}: ${String(cause)}`)
      }
    },
    [client, workspaceId, onSaved, runDiagnostics],
  )

  // Poll the active file's fingerprint to spot agent/git edits. Clean buffer →
  // auto-reload; dirty buffer → flag a non-destructive warning (never clobber).
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

  // ⌘P opens the quick-open palette (the buffer's own ⌘S keymap handles save).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault()
        setQuickOpen(true)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  // Autosave: when on, persist a dirty active buffer after a short keystroke
  // debounce. ⌘S still works; this just removes the need to press it. The effect
  // re-runs on every content change (so each edit resets the timer) and only
  // arms when the live content differs from what's on disk.
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

  /** Save the active buffer on blur when autosave is on (catches a tab switch / focus loss). */
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

  // Build the buffer's diagnostics source from the active file's cached result.
  // Identity changes whenever the result does, so CodeMirror re-runs the linter
  // and redraws squiggles after each save/open — matching the one-shot model.
  const activeResult = active ? (diagnostics[active.relPath]?.result ?? null) : null
  const diagnosticsSource = useMemo<DiagnosticsSource | undefined>(() => {
    if (!active || !isPythonPath(active.relPath) || !activeResult) return undefined
    const list = activeResult.diagnostics
    return (doc: string) => toCmDiagnostics(doc, list)
  }, [active, activeResult])

  const activeDiagnostics = active
    ? (diagnostics[active.relPath] ?? EMPTY_DIAGNOSTICS)
    : EMPTY_DIAGNOSTICS
  const statusCounts = activeDiagnostics.result
    ? countDiagnostics(activeDiagnostics.result.diagnostics)
    : EMPTY_COUNTS
  const statusMissing = activeDiagnostics.result?.missing ?? []

  return (
    <div data-testid="editor" className="flex h-full min-h-0 w-full" onBlurCapture={onBlurCapture}>
      <aside className="flex w-56 shrink-0 flex-col border-border border-r bg-muted/20">
        <FileTree workspaceId={workspaceId} onOpenFile={openFile} />
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-stretch">
          <div className="min-w-0 flex-1 overflow-hidden">
            <EditorTabs
              tabs={tabs}
              activeRelPath={activeRelPath}
              onSelect={setActiveRelPath}
              onClose={closeFile}
            />
          </div>
          <div className="flex shrink-0 items-center border-border border-b bg-muted/30 px-1">
            <EditorSettingsMenu settings={settings} onChange={onUpdateEditorSettings} />
          </div>
        </div>

        {error ? (
          <p
            data-testid="editor-error"
            className="shrink-0 cursor-text select-text border-border border-b bg-destructive/10 px-4 py-2 text-destructive text-xs"
          >
            {error}
          </p>
        ) : null}

        {active?.externalChange ? (
          <div
            data-testid="editor-external-warning"
            className="flex shrink-0 items-center gap-2 border-border border-b bg-amber-500/10 px-4 py-2 text-amber-600 text-xs dark:text-amber-400"
          >
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
            <span className="select-text">
              {active.relPath} changed on disk and you have unsaved edits. Save to overwrite, or
              close without saving to keep the on-disk version.
            </span>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col">
          {active ? (
            <CodeMirrorBuffer
              // A new epoch (after an external auto-reload) reseeds the doc.
              key={`${active.relPath}#${active.epoch}`}
              relPath={active.relPath}
              initialDoc={active.content}
              onChange={(doc) => onEdit(active.relPath, doc)}
              onSave={() => void saveFile(active.relPath)}
              vim={settings.vim}
              diagnostics={diagnosticsSource}
            />
          ) : (
            <div
              data-testid="editor-empty"
              className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground/70 text-sm"
            >
              Open a file from the tree or press ⌘P
            </div>
          )}
        </div>

        <EditorStatusBar
          relPath={active?.relPath ?? null}
          isPython={active ? isPythonPath(active.relPath) : false}
          counts={statusCounts}
          missing={statusMissing}
          checking={activeDiagnostics.checking}
          hasRun={activeDiagnostics.hasRun}
        />
      </div>

      {quickOpen ? (
        <QuickOpen
          workspaceId={workspaceId}
          onOpenFile={openFile}
          onClose={() => setQuickOpen(false)}
        />
      ) : null}
    </div>
  )
}

/**
 * Compare a buffer against its on-disk fingerprint and reconcile out-of-band
 * edits (AGENTS.md §0 — never silently clobber). When the fingerprint is
 * unchanged, do nothing. When it changed:
 *   - buffer **clean** ⇒ re-read and reseed the doc (bump `epoch` to remount the
 *     CodeMirror view), refreshing the baseline, then re-run diagnostics.
 *   - buffer **dirty** ⇒ set `externalChange` so the UI warns; do not touch the
 *     user's edits.
 */
async function reconcileExternal(
  client: SkipperTrpcClient,
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

  // Clean buffer: pull the new content and reseed.
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
  // The on-disk content changed under us — refresh diagnostics for the new file.
  void runDiagnostics(buffer.relPath)
}
