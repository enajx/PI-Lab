import type { Diagnostic as CmDiagnostic } from "@codemirror/lint"
import type { SkipperTrpcClient } from "../../../trpc/client"
import type { RouterOutputs } from "../../../trpc/types"

/**
 * Renderer-side Python diagnostics integration for the built-in editor (AGENTS.md
 * §1, TODO "Built-in editor"). The diagnostics *engine* runs in main as one-shot
 * CLIs over `diagnostics.check`; this module is the thin glue that
 *   1. decides whether a file is even a Python file (no diagnostics otherwise),
 *   2. calls the router for the **saved** file, and
 *   3. maps the normalized {@link SkipperDiagnostic}s into CodeMirror's
 *      `@codemirror/lint` shape (character offsets + severities) so the buffer
 *      draws squiggles / gutter markers / hover tooltips.
 *
 * The check runs against the file on disk (the editor saves first), so the live
 * `doc` text the linter hands us is used only to convert 1-based line/column
 * positions into document offsets — never sent to the tool.
 */

/** The normalized diagnostic the `diagnostics.check` procedure returns. */
export type SkipperDiagnostic = RouterOutputs["diagnostics"]["check"]["diagnostics"][number]

/** The full result of one diagnostics run, surfaced to the editor status bar. */
export type DiagnosticsRunResult = RouterOutputs["diagnostics"]["check"]

/** Which type checker the diagnostics run should use (mirrors the editor setting). */
export type DiagnosticsTypeChecker = "ty" | "pyrefly"

/** A file is Python-eligible iff it ends in `.py`/`.pyi` (case-insensitive). */
export function isPythonPath(relPath: string): boolean {
  return /\.pyi?$/i.test(relPath)
}

/**
 * Convert one 1-based (line, column) position into a 0-based document offset for
 * the given doc. Out-of-range lines/columns are clamped so a stale position from
 * a tool that ran on slightly older content can never throw or point outside the
 * doc. Columns are 1-based and inclusive of the start, matching every tool here.
 */
export function lineColToOffset(doc: string, line: number, column: number): number {
  const lines = doc.split("\n")
  const lineIndex = Math.min(Math.max(line - 1, 0), lines.length - 1)
  let offset = 0
  for (let i = 0; i < lineIndex; i++) {
    // +1 for the "\n" that split() removed.
    offset += (lines[i]?.length ?? 0) + 1
  }
  const lineLength = lines[lineIndex]?.length ?? 0
  const col = Math.min(Math.max(column - 1, 0), lineLength)
  return offset + col
}

/** Map a normalized severity onto CodeMirror's lint severity vocabulary. */
function cmSeverity(severity: SkipperDiagnostic["severity"]): CmDiagnostic["severity"] {
  // CodeMirror knows error | warning | info | hint; our model has no "hint".
  return severity
}

/**
 * Map the router's normalized diagnostics into CodeMirror lint diagnostics for a
 * given document. Positions become offsets; a diagnostic with an end position
 * spans the offending range, otherwise it marks a single character so the
 * squiggle is still visible. The source + code are folded into the message and a
 * stable `source` tag so the gutter/tooltip identify the tool.
 */
export function toCmDiagnostics(doc: string, diagnostics: SkipperDiagnostic[]): CmDiagnostic[] {
  return diagnostics.map((d) => {
    const from = lineColToOffset(doc, d.line, d.column)
    const to =
      d.endLine != null && d.endColumn != null
        ? Math.max(lineColToOffset(doc, d.endLine, d.endColumn), from)
        : from
    return {
      from,
      // Ensure a visible mark even for a zero-width range (clamp to doc length).
      to: to === from ? Math.min(from + 1, doc.length) : to,
      severity: cmSeverity(d.severity),
      source: d.code ? `${d.source} (${d.code})` : d.source,
      message: d.message,
    }
  })
}

/** Per-severity tallies for the status bar. */
export interface DiagnosticCounts {
  errors: number
  warnings: number
  infos: number
}

/** Tally a diagnostics list by severity for the status-bar summary. */
export function countDiagnostics(diagnostics: SkipperDiagnostic[]): DiagnosticCounts {
  const counts: DiagnosticCounts = { errors: 0, warnings: 0, infos: 0 }
  for (const d of diagnostics) {
    if (d.severity === "error") counts.errors++
    else if (d.severity === "warning") counts.warnings++
    else counts.infos++
  }
  return counts
}

/**
 * Run the diagnostics check for a saved Python file over the tRPC client. Returns
 * `null` for non-Python files (no diagnostics) so callers can short-circuit the
 * status bar entirely. Never throws on tooling absence — that surfaces as
 * `toolsAvailable: false` / `missing[]` in the result.
 */
export async function runPythonCheck(
  client: SkipperTrpcClient,
  params: {
    workspaceId: string
    relPath: string
    typeChecker: DiagnosticsTypeChecker
  },
): Promise<DiagnosticsRunResult | null> {
  if (!isPythonPath(params.relPath)) return null
  return client.diagnostics.check.query({
    workspaceId: params.workspaceId,
    relPath: params.relPath,
    typeChecker: params.typeChecker,
    // v1 always runs ruff alongside the type checker (TODO "Built-in editor").
    lint: true,
  })
}
