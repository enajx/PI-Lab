/**
 * Pure parser for `pyrefly check <file> --output-format json`. pyrefly prints a JSON **object**
 * `{ "errors": [ … ] }` on stdout (its `INFO`/summary lines go to stderr, so the
 * captured stdout is clean JSON). Each error carries 1-based `line`/`column`,
 * optional `stop_line`/`stop_column` (the range end), a rule `name`, a
 * `description`, and a `severity`. We map each into a normalized
 * {@link Diagnostic}, preferring `description` for the message and using `name`
 * as the rule code.
 *
 * As with the ruff/ty parsers, this **never throws**: invalid JSON, a missing or
 * non-array `errors`, or entries lacking a position all degrade to `[]` / a
 * skipped entry, which the property tests assert.
 */

import type { Diagnostic, DiagnosticSeverity } from "./types"

/** One pyrefly error entry, every field optional for defensive parsing. */
interface PyreflyError {
  line?: unknown
  column?: unknown
  stop_line?: unknown
  stop_column?: unknown
  name?: unknown
  description?: unknown
  concise_description?: unknown
  severity?: unknown
}

/**
 * Parse pyrefly's JSON stdout into normalized diagnostics. Accepts the raw
 * string; returns `[]` for empty output, invalid JSON, or a payload without an
 * `errors` array.
 */
export function parsePyreflyJson(stdout: string): Diagnostic[] {
  const root = safeJsonParse(stdout)
  if (!isObject(root)) return []

  const errors = (root as { errors?: unknown }).errors
  if (!Array.isArray(errors)) return []

  const diagnostics: Diagnostic[] = []
  for (const raw of errors) {
    const diagnostic = toDiagnostic(raw)
    if (diagnostic) diagnostics.push(diagnostic)
  }
  return diagnostics
}

/** Map one pyrefly error to a Diagnostic, or `null` if it lacks a position. */
function toDiagnostic(raw: unknown): Diagnostic | null {
  if (!isObject(raw)) return null
  const error = raw as PyreflyError

  const line = positiveInt(error.line)
  const column = positiveInt(error.column)
  if (line === undefined || column === undefined) return null

  const diagnostic: Diagnostic = {
    source: "pyrefly",
    severity: toSeverity(error.severity),
    line,
    column,
    message: cleanString(error.description) ?? cleanString(error.concise_description) ?? "",
  }

  const endLine = positiveInt(error.stop_line)
  const endColumn = positiveInt(error.stop_column)
  if (endLine !== undefined) diagnostic.endLine = endLine
  if (endColumn !== undefined) diagnostic.endColumn = endColumn

  const code = cleanString(error.name)
  if (code !== undefined) diagnostic.code = code

  return diagnostic
}

/** Map pyrefly's severity word to ours; type errors default to `error`. */
function toSeverity(value: unknown): DiagnosticSeverity {
  if (typeof value !== "string") return "error"
  const normalized = value.trim().toLowerCase()
  if (normalized === "warn" || normalized === "warning") return "warning"
  if (normalized === "info" || normalized === "information" || normalized === "note") return "info"
  return "error"
}

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

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return undefined
  return value
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
