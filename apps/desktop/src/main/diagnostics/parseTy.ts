/**
 * Pure parser for `ty check <file> --output-format concise --color never`
 * (AGENTS.md §1, TODO "Built-in editor"). ty's "concise" format prints one
 * diagnostic per line:
 *
 *   path/to/file.py:LINE:COL: SEVERITY[rule-code] message text
 *
 * (e.g. `app.py:4:16: error[unresolved-reference] Name \`x\` used when not
 * defined`), plus a trailing summary line like `Found 2 diagnostics` or
 * `All checks passed!` which carries no position and is ignored. We chose
 * `concise` over the `gitlab` JSON because it is line-oriented, stable, and the
 * documented one-per-line shape — the parser stays simple and total.
 *
 * Like the ruff parser this **never throws**: any line that doesn't match the
 * shape (the summary, blank lines, ANSI residue, arbitrary garbage) is skipped,
 * which the property tests assert (AGENTS.md §14).
 */

import type { Diagnostic, DiagnosticSeverity } from "./types"

/**
 * Match `…:LINE:COL: SEVERITY[code] message` at the *end* of a line. The path
 * prefix is `.+?` (lazy, may itself contain colons / a Windows drive), anchored
 * to the trailing `:line:col:` so only the final two numeric groups are taken as
 * the position. The `[code]` bracket is optional. Capture groups:
 *   1 = line, 2 = column, 3 = severity word, 4 = code (optional), 5 = message.
 */
const TY_LINE = /^.+?:(\d+):(\d+):\s*([A-Za-z]+)(?:\[([^\]]*)\])?\s*(.*)$/

/**
 * Parse ty's concise stdout into normalized diagnostics. Splits on newlines and
 * maps each matching line; non-matching lines (summary, blanks) are dropped.
 */
export function parseTyConcise(stdout: string): Diagnostic[] {
  return parseConciseLines(stdout, "ty")
}

/**
 * Shared concise-line parser. `ty` and (in `min-text` form) other checkers print
 * the same `file:line:col: severity[code] message` shape; the `source` tag is
 * the only difference, so the line parser is reused with the source threaded in.
 */
export function parseConciseLines(stdout: string, source: "ty" | "pyrefly"): Diagnostic[] {
  if (typeof stdout !== "string" || stdout.length === 0) return []

  const diagnostics: Diagnostic[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trim()
    if (line.length === 0) continue

    const match = TY_LINE.exec(line)
    if (!match) continue

    const startLine = positiveInt(match[1])
    const column = positiveInt(match[2])
    if (startLine === undefined || column === undefined) continue

    const diagnostic: Diagnostic = {
      source,
      severity: toSeverity(match[3]),
      line: startLine,
      column,
      message: (match[5] ?? "").trim(),
    }
    const code = cleanString(match[4])
    if (code !== undefined) diagnostic.code = code

    diagnostics.push(diagnostic)
  }
  return diagnostics
}

/** Map a tool's severity word to ours; unknown words become `warning`. */
function toSeverity(word: string | undefined): DiagnosticSeverity {
  const normalized = (word ?? "").toLowerCase()
  if (normalized === "error") return "error"
  if (normalized === "warning" || normalized === "warn") return "warning"
  if (normalized === "info" || normalized === "information" || normalized === "note") return "info"
  return "warning"
}

/** Strip ANSI escape sequences so `--color never` slips don't break matching. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape (ESC) is intentional.
const ANSI = /\[[0-9;]*m/g
function stripAnsi(text: string): string {
  return text.replace(ANSI, "")
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1) return undefined
  return parsed
}

function cleanString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
