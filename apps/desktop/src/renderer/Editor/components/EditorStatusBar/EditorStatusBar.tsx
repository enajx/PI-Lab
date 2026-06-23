import { AlertCircle, AlertTriangle, CheckCircle2, Info, TerminalSquare } from "lucide-react"
import type { DiagnosticCounts } from "../../utils/pythonDiagnostics"

interface EditorStatusBarProps {
  /**
   * The active file's path (working-dir-relative), or null when nothing is open.
   * Shown on the left for a quick "what am I editing" cue.
   */
  relPath: string | null
  /** Whether the active file is a Python file (drives whether diagnostics show). */
  isPython: boolean
  /** Per-severity diagnostic tallies for the active file's last check. */
  counts: DiagnosticCounts
  /**
   * Tools that were requested but absent (e.g. `["ruff"]`). When non-empty the
   * bar shows a subtle "install uv" hint instead of a clean/error count, per the
   * spec's graceful "uv not found" path (TODO "Built-in editor").
   */
  missing: string[]
  /** True while a diagnostics check is in flight (shows a muted "checking…"). */
  checking: boolean
  /** Whether a diagnostics check has completed at least once for this file. */
  hasRun: boolean
}

/**
 * The editor's bottom status bar (AGENTS.md §1, TODO "Built-in editor" — "a small
 * error/warning count in the status bar"). For a Python file it surfaces the last
 * diagnostics run as a compact error/warning/info count (or a clean check), and
 * when the Astral tools are absent it shows a subtle, non-alarming hint to install
 * `uv` rather than dressing a tooling gap up as an error. Non-Python files show
 * nothing diagnostic-related.
 */
export function EditorStatusBar({
  relPath,
  isPython,
  counts,
  missing,
  checking,
  hasRun,
}: EditorStatusBarProps) {
  return (
    <div
      data-testid="editor-status-bar"
      className="flex h-6 shrink-0 items-center justify-between gap-3 border-border border-t bg-muted/30 px-3 text-[11px] text-muted-foreground"
    >
      <span className="min-w-0 truncate" title={relPath ?? undefined}>
        {relPath ?? "No file open"}
      </span>

      <div className="flex shrink-0 items-center gap-3">
        {relPath && isPython ? (
          <DiagnosticsSummary
            counts={counts}
            missing={missing}
            checking={checking}
            hasRun={hasRun}
          />
        ) : null}
      </div>
    </div>
  )
}

function DiagnosticsSummary({
  counts,
  missing,
  checking,
  hasRun,
}: Pick<EditorStatusBarProps, "counts" | "missing" | "checking" | "hasRun">) {
  if (missing.length > 0) {
    return (
      <span
        data-testid="editor-tools-missing"
        className="flex items-center gap-1 text-muted-foreground/80"
        title={`Missing: ${missing.join(", ")}. Install uv (uvx ships with it) to enable Python diagnostics.`}
      >
        <TerminalSquare className="size-3" aria-hidden />
        Python tools unavailable (install uv)
      </span>
    )
  }

  if (checking && !hasRun) {
    return (
      <span data-testid="editor-diagnostics-checking" className="text-muted-foreground/70">
        Checking…
      </span>
    )
  }

  if (!hasRun) return null

  const { errors, warnings, infos } = counts
  if (errors === 0 && warnings === 0 && infos === 0) {
    return (
      <span
        data-testid="editor-diagnostics-clean"
        className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"
      >
        <CheckCircle2 className="size-3" aria-hidden />
        No problems
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
