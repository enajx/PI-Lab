/**
 * Normalized diagnostics model for the built-in editor's Python code intelligence.
 * v1 runs the Astral tools as **one-shot
 * CLIs** — a type checker (`ty`, toggleable to `pyrefly`) and the linter `ruff` —
 * and maps their disparate outputs into the single {@link Diagnostic} shape below
 * so the editor renders squiggles, gutter markers, and a status count from one
 * uniform list (no LSP, no Problems panel).
 *
 * These types are I/O-free on purpose: the per-tool parsers that produce them are
 * pure (`string`/`unknown` → `Diagnostic[]`), so they are example- and
 * property-testable without `uv` installed.
 */

/** Which tool emitted a diagnostic — drives the badge/source label in the gutter. */
export type DiagnosticSource = "ty" | "pyrefly" | "ruff"

/**
 * Severity, normalized across tools. The editor maps these to squiggle colors;
 * anything a tool reports that isn't clearly an error is treated as a warning,
 * and purely informational notes as `info`.
 */
export type DiagnosticSeverity = "error" | "warning" | "info"

/**
 * One normalized diagnostic. Positions are **1-based** line/column, matching what
 * every tool here reports and what CodeMirror expects after a `line`→offset
 * conversion. `endLine`/`endColumn` are present when the tool gives a range (so
 * the squiggle can span the offending token); `code` is the tool's rule id
 * (e.g. ruff `F401`, ty `unresolved-reference`) when one exists.
 */
export interface Diagnostic {
  source: DiagnosticSource
  severity: DiagnosticSeverity
  /** 1-based start line. */
  line: number
  /** 1-based start column. */
  column: number
  /** 1-based end line, when the tool reports a range. */
  endLine?: number
  /** 1-based end column, when the tool reports a range. */
  endColumn?: number
  message: string
  /** Tool rule/code id, when present. */
  code?: string
}

/** The type checker the diagnostics run uses. */
export type TypeChecker = "ty" | "pyrefly"

/**
 * Outcome of a single tool invocation, before merging. Always resolves (never
 * throws): when the binary is missing, `available` is `false` and `diagnostics`
 * is empty so the caller can report it as a tooling gap rather than a check
 * failure.
 */
export interface ToolRunResult {
  /** Whether the underlying CLI was found and ran (vs. absent / unspawnable). */
  available: boolean
  diagnostics: Diagnostic[]
}

/**
 * Aggregate result the diagnostics router returns to the editor: the merged
 * diagnostic list plus a typed tooling-availability signal. `toolsAvailable` is
 * `false` when *any* requested tool was missing, and `missing` names which ones,
 * so the editor can prompt to install `uv`/`ty`/`ruff` rather than silently
 * showing no problems (handle the "uv not found" path
 * gracefully).
 */
export interface DiagnosticsResult {
  diagnostics: Diagnostic[]
  toolsAvailable: boolean
  /** Names of the requested tools that were absent (subset of the run's tools). */
  missing: string[]
}
