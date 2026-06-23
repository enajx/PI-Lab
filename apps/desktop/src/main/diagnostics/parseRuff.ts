/**
 * Pure parser for `ruff check <file> --output-format json` (AGENTS.md §1, TODO
 * "Built-in editor"). Ruff prints a JSON **array**; each entry has a `code`, a
 * 1-based `location` ({ row, column }), an optional `end_location`, a `message`,
 * and (newer ruff) a `severity`. We map each into the normalized {@link Diagnostic}.
 *
 * Defensive by contract: this takes the *raw stdout string*, decodes it itself,
 * and **never throws** — malformed JSON, a non-array payload, or individual
 * entries missing fields all degrade to an empty list / skipped entry. That
 * totality is what the property tests assert (AGENTS.md §14), and it means a
 * future ruff output tweak can't crash the editor's save path.
 */

import type { Diagnostic, DiagnosticSeverity } from "./types"

/** A `{ row, column }` position as ruff reports it (1-based). */
interface RuffPosition {
  row?: unknown
  column?: unknown
}

/** One ruff diagnostic entry, with every field optional for safe parsing. */
interface RuffEntry {
  code?: unknown
  message?: unknown
  severity?: unknown
  location?: RuffPosition
  end_location?: RuffPosition
}

/**
 * Parse ruff's JSON stdout into normalized diagnostics. Accepts the raw string;
 * returns `[]` for empty output, whitespace, invalid JSON, or a non-array root.
 */
export function parseRuffJson(stdout: string): Diagnostic[] {
  const root = safeJsonParse(stdout)
  if (!Array.isArray(root)) return []

  const diagnostics: Diagnostic[] = []
  for (const raw of root) {
    const diagnostic = toDiagnostic(raw)
    if (diagnostic) diagnostics.push(diagnostic)
  }
  return diagnostics
}

/** Map one ruff entry to a Diagnostic, or `null` if it lacks a usable position. */
function toDiagnostic(raw: unknown): Diagnostic | null {
  if (!isObject(raw)) return null
  const entry = raw as RuffEntry

  const line = positiveInt(entry.location?.row)
  const column = positiveInt(entry.location?.column)
  if (line === undefined || column === undefined) return null

  const diagnostic: Diagnostic = {
    source: "ruff",
    severity: ruffSeverity(entry.severity),
    line,
    column,
    message: cleanString(entry.message) ?? "",
  }

  const endLine = positiveInt(entry.end_location?.row)
  const endColumn = positiveInt(entry.end_location?.column)
  if (endLine !== undefined) diagnostic.endLine = endLine
  if (endColumn !== undefined) diagnostic.endColumn = endColumn

  const code = cleanString(entry.code)
  if (code !== undefined) diagnostic.code = code

  return diagnostic
}

/**
 * Map ruff's severity to ours. Ruff lint findings are surfaced as `error` by the
 * tool; only an explicit `warning`/`info` (or an unknown value, treated as a
 * warning to avoid over-stating problems) deviates.
 */
function ruffSeverity(value: unknown): DiagnosticSeverity {
  if (typeof value !== "string") return "error"
  const normalized = value.trim().toLowerCase()
  if (normalized === "error") return "error"
  if (normalized === "warning" || normalized === "warn") return "warning"
  if (normalized === "info" || normalized === "information" || normalized === "note") return "info"
  return "warning"
}

/** JSON.parse that returns `undefined` instead of throwing on bad input. */
function safeJsonParse(text: unknown): unknown {
  if (typeof text !== "string" || text.trim().length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A finite, strictly-positive integer, else `undefined`. */
function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return undefined
  return value
}

/** A trimmed non-empty string, else `undefined`. */
function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
