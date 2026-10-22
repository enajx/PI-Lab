import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  CodeXml,
  Eye,
  FolderOpen,
  Info,
  RefreshCw,
  TerminalSquare,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTranslate } from "../../../i18n/language"
import type { RouterOutputs } from "../../../trpc/types"
import type { PythonRuntimeState } from "../../hooks/useEditorBuffers/useEditorBuffers"
import type { DiagnosticCounts } from "../../utils/pythonDiagnostics"

interface EditorStatusBarProps {
  /** Whether the active file is a Python file (drives whether diagnostics show). */
  isPython: boolean
  /** Per-severity diagnostic tallies for the active file's last check. */
  counts: DiagnosticCounts
  /**
   * Tools that were requested but absent (e.g. `["ruff"]`). When non-empty the
   * bar shows a subtle "install uv" hint instead of a clean/error count, per the
   * spec's graceful "uv not found" path.
   */
  missing: string[]
  /** True while a diagnostics check is in flight (shows a muted "checking…"). */
  checking: boolean
  /** Whether a diagnostics check has completed at least once for this file. */
  hasRun: boolean
  outdated: boolean
  onRefreshDiagnostics: () => void
  /** Persisted on/off state for Python type-checking and linting. */
  diagnosticsEnabled: boolean
  /** Toggle the persisted diagnostics preference. */
  onToggleDiagnostics: () => void
  pythonRuntime: PythonRuntimeState
  listPythonEnvironments: () => Promise<RouterOutputs["python"]["options"]>
  selectPythonEnvironment: (path: string | null) => Promise<boolean>
  choosePythonEnvironment: (kind: "directory" | "interpreter") => Promise<boolean>
  /** Markdown buffers can switch their source/render presentation from the lower status bar. */
  markdownMode?: "render" | "source"
  onMarkdownModeChange?: (mode: "render" | "source") => void
}

/**
 * The editor's bottom status bar ("a small
 * error/warning count in the status bar"). For a Python file it surfaces the last
 * diagnostics run as a compact error/warning/info count (or a clean check), and
 * when the Astral tools are absent it shows a subtle, non-alarming hint to install
 * `uv` rather than dressing a tooling gap up as an error. Non-Python files show
 * nothing diagnostic-related.
 */
export function EditorStatusBar({
  isPython,
  counts,
  missing,
  checking,
  hasRun,
  outdated,
  onRefreshDiagnostics,
  diagnosticsEnabled,
  onToggleDiagnostics,
  pythonRuntime,
  listPythonEnvironments,
  selectPythonEnvironment,
  choosePythonEnvironment,
  markdownMode,
  onMarkdownModeChange,
}: EditorStatusBarProps) {
  const t = useTranslate()
  return (
    <div
      data-testid="editor-status-bar"
      className="flex h-6 shrink-0 items-center justify-end gap-3 border-border border-t bg-muted/30 px-3 text-[11px] text-muted-foreground"
    >
      <div className="flex shrink-0 items-center gap-3">
        {isPython ? (
          <>
            <PythonRuntimeSummary
              state={pythonRuntime}
              listEnvironments={listPythonEnvironments}
              selectEnvironment={selectPythonEnvironment}
              chooseEnvironment={choosePythonEnvironment}
            />
            <DiagnosticsSummary
              counts={counts}
              missing={missing}
              checking={checking}
              hasRun={hasRun && !outdated}
              enabled={diagnosticsEnabled}
              onToggle={onToggleDiagnostics}
            />
            {diagnosticsEnabled ? (
              <>
                {outdated ? (
                  <span data-testid="editor-diagnostics-outdated">{t("Diagnostics outdated")}</span>
                ) : null}
                <button
                  type="button"
                  data-testid="editor-diagnostics-refresh"
                  aria-label={t("Refresh Python diagnostics")}
                  title={t("Check the saved file")}
                  disabled={checking}
                  onClick={onRefreshDiagnostics}
                  className="rounded px-1 hover:bg-accent disabled:opacity-50"
                >
                  <RefreshCw className="size-3" aria-hidden />
                </button>
              </>
            ) : null}
          </>
        ) : null}
      </div>
      {markdownMode && onMarkdownModeChange ? (
        <fieldset
          data-testid="markdown-mode-toggle"
          aria-label={t("Markdown view")}
          className="flex shrink-0 items-center rounded border border-border bg-background p-0.5"
        >
          <button
            type="button"
            aria-label={t("Render Markdown")}
            aria-pressed={markdownMode === "render"}
            onClick={() => onMarkdownModeChange("render")}
            className={
              markdownMode === "render"
                ? "flex size-4 items-center justify-center rounded-sm bg-accent text-foreground"
                : "flex size-4 items-center justify-center rounded-sm hover:bg-accent/60"
            }
          >
            <Eye className="size-3" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t("Source Markdown")}
            aria-pressed={markdownMode === "source"}
            onClick={() => onMarkdownModeChange("source")}
            className={
              markdownMode === "source"
                ? "flex size-4 items-center justify-center rounded-sm bg-accent text-foreground"
                : "flex size-4 items-center justify-center rounded-sm hover:bg-accent/60"
            }
          >
            <CodeXml className="size-3" aria-hidden />
          </button>
        </fieldset>
      ) : null}
    </div>
  )
}

interface PythonRuntimeSummaryProps {
  state: PythonRuntimeState
  listEnvironments: () => Promise<RouterOutputs["python"]["options"]>
  selectEnvironment: (path: string | null) => Promise<boolean>
  chooseEnvironment: (kind: "directory" | "interpreter") => Promise<boolean>
}

function PythonRuntimeSummary({
  state,
  listEnvironments,
  selectEnvironment,
  chooseEnvironment,
}: PythonRuntimeSummaryProps) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<RouterOutputs["python"]["options"]>([])
  const [loading, setLoading] = useState(false)
  const [menuError, setMenuError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", dismiss)
    document.addEventListener("keydown", dismissOnEscape)
    return () => {
      document.removeEventListener("mousedown", dismiss)
      document.removeEventListener("keydown", dismissOnEscape)
    }
  }, [open])

  const toggle = async (): Promise<void> => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    setLoading(true)
    setMenuError(null)
    try {
      setOptions(await listEnvironments())
    } catch (cause) {
      setMenuError(`${t("Could not list Python environments:")} ${String(cause)}`)
    } finally {
      setLoading(false)
    }
  }

  const select = async (path: string | null): Promise<void> => {
    if (await selectEnvironment(path)) setOpen(false)
  }

  const choose = async (kind: "directory" | "interpreter"): Promise<void> => {
    if (await chooseEnvironment(kind)) setOpen(false)
  }

  const label =
    state.checking && !state.runtime
      ? t("Detecting Python…")
      : state.error && !state.runtime
        ? t("Python env unavailable")
        : (state.runtime?.displayName ?? t("No virtual env"))
  const strategy = state.runtime?.runStrategy
  const tooltip =
    state.error ??
    state.runtime?.interpreterPath ??
    (strategy?.command
      ? [strategy.command, ...strategy.argsPrefix].join(" ")
      : t("No Python runtime"))
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="editor-python-runtime"
        title={tooltip}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => void toggle()}
        className="flex items-center gap-0.5 rounded px-1 transition-colors hover:bg-accent hover:text-foreground"
      >
        {label}
        <ChevronDown className="size-3" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={t("Python environment")}
          className="absolute end-0 bottom-full z-30 mb-1 max-h-[min(24rem,70vh)] w-80 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <div className="px-2 py-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
            {t("Python environment")}
          </div>
          {loading ? <div className="px-2 py-2 text-muted-foreground">{t("Checking…")}</div> : null}
          {menuError ? (
            <div className="px-2 py-2 text-destructive" title={menuError}>
              {t("Environments unavailable")}
            </div>
          ) : null}
          {state.error ? (
            <div
              data-testid="python-environment-selection-error"
              className="mx-1 mb-1 rounded bg-destructive/10 px-2 py-1.5 text-destructive text-xs"
            >
              {state.error}
            </div>
          ) : null}
          {!loading
            ? options.map((option) => {
                const selected =
                  option.interpreterPath === state.runtime?.interpreterPath &&
                  state.runtime.source !== null
                return (
                  <button
                    type="button"
                    role="menuitem"
                    key={option.interpreterPath}
                    onClick={() => void select(option.path)}
                    className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-start hover:bg-accent"
                  >
                    <span className="mt-0.5 w-3 shrink-0">
                      {selected ? <Check className="size-3" aria-hidden /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs">{option.displayName}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {option.interpreterPath}
                      </span>
                    </span>
                  </button>
                )
              })
            : null}
          <div className="my-1 border-border border-t" />
          <button
            type="button"
            role="menuitem"
            onClick={() => void select(null)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-xs hover:bg-accent"
          >
            <span className="w-3 shrink-0">
              {state.runtime?.source !== "selected" ? (
                <Check className="size-3" aria-hidden />
              ) : null}
            </span>
            {t("Auto-detect")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void choose("directory")}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-xs hover:bg-accent"
          >
            <FolderOpen className="size-3 shrink-0" aria-hidden />
            {t("Choose environment folder…")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void choose("interpreter")}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-xs hover:bg-accent"
          >
            <TerminalSquare className="size-3 shrink-0" aria-hidden />
            {t("Choose Python interpreter…")}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function DiagnosticsSummary({
  counts,
  missing,
  checking,
  hasRun,
  enabled,
  onToggle,
}: Pick<EditorStatusBarProps, "counts" | "missing" | "checking" | "hasRun"> & {
  enabled: boolean
  onToggle: () => void
}) {
  const t = useTranslate()
  const title = enabled
    ? t("Python type checking is on. Click to turn it off.")
    : t("Python type checking is off. Click to turn it on.")
  return (
    <button
      type="button"
      data-testid="editor-diagnostics-toggle"
      aria-label={enabled ? t("Turn Python type checking off") : t("Turn Python type checking on")}
      aria-pressed={enabled}
      title={title}
      onClick={onToggle}
      className="flex items-center gap-2 rounded px-1 transition-colors hover:bg-accent hover:text-foreground"
    >
      <DiagnosticsContent
        enabled={enabled}
        counts={counts}
        missing={missing}
        checking={checking}
        hasRun={hasRun}
      />
    </button>
  )
}

function DiagnosticsContent({
  enabled,
  counts,
  missing,
  checking,
  hasRun,
}: Pick<EditorStatusBarProps, "counts" | "missing" | "checking" | "hasRun"> & {
  enabled: boolean
}) {
  const t = useTranslate()
  if (!enabled) {
    return <span className="text-muted-foreground/70">{t("Type check: Off")}</span>
  }
  if (missing.length > 0) {
    return (
      <span
        data-testid="editor-tools-missing"
        className="flex items-center gap-1 text-muted-foreground/80"
        title={`${t("Missing:")} ${missing.join(", ")}. ${t("Install uv (uvx ships with it) to enable Python diagnostics.")}`}
      >
        <TerminalSquare className="size-3" aria-hidden />
        {t("Python tools unavailable (install uv)")}
      </span>
    )
  }
  if (checking && !hasRun) {
    return (
      <span data-testid="editor-diagnostics-checking" className="text-muted-foreground/70">
        {t("Checking…")}
      </span>
    )
  }
  if (!hasRun) return <span className="text-muted-foreground/70">{t("Diagnostics on")}</span>

  const { errors, warnings, infos } = counts
  if (errors === 0 && warnings === 0 && infos === 0) {
    return (
      <span
        data-testid="editor-diagnostics-clean"
        className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"
      >
        <CheckCircle2 className="size-3" aria-hidden />
        {t("No problems")}
      </span>
    )
  }
  return (
    <span data-testid="editor-diagnostics-count" className="flex items-center gap-2">
      {errors > 0 ? (
        <span
          data-testid="editor-diagnostics-errors"
          className="flex items-center gap-1 text-destructive"
        >
          <AlertCircle className="size-3" aria-hidden />
          {errors}
        </span>
      ) : null}
      {warnings > 0 ? (
        <span
          data-testid="editor-diagnostics-warnings"
          className="flex items-center gap-1 text-amber-600 dark:text-amber-400"
        >
          <AlertTriangle className="size-3" aria-hidden />
          {warnings}
        </span>
      ) : null}
      {infos > 0 ? (
        <span className="flex items-center gap-1 text-sky-600 dark:text-sky-400">
          <Info className="size-3" aria-hidden />
          {infos}
        </span>
      ) : null}
    </span>
  )
}
