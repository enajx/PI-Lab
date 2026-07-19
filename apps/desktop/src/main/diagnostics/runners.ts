/**
 * One-shot diagnostics runners for the built-in editor's Python code intelligence
 * (AGENTS.md "Scope", TODO "Built-in editor"). Each runner invokes a single Astral CLI
 * through the injected {@link PyToolsExec} and maps its output via the matching
 * pure parser. They are deliberately small and side-effect-light — all I/O is the
 * one exec call, so the diagnostics router's tests drive them with a canned exec
 * and need no `uv` (md/engineering/testing-and-build.md).
 *
 * **Graceful when tools are absent (hard requirement):** a missing binary
 * (`uv`/`ty`/`ruff`/`pyrefly` not installed → `notFound`) is never thrown; it
 * resolves to `{ available: false, diagnostics: [] }` so the router can report a
 * tooling gap rather than a check failure. A tool that runs and *finds* problems
 * (non-zero exit) is a normal `available: true` result.
 */

import { parsePyreflyJson } from "./parsePyrefly"
import { parseRuffJson } from "./parseRuff"
import { parseTyConcise } from "./parseTy"
import type { PyToolsExec } from "./pyToolsExec"
import type { ToolRunResult, TypeChecker } from "./types"

const TOOL_UNAVAILABLE: ToolRunResult = { available: false, diagnostics: [] }

/**
 * Type-check one file with the selected checker. `ty` uses the line-based
 * `concise` format; `pyrefly` uses its JSON format (the two parsers normalize to
 * the same shape). Returns the typed unavailable result when the binary is
 * missing.
 */
export async function runTypeCheck(
  exec: PyToolsExec,
  checker: TypeChecker,
  relPath: string,
  cwd: string,
): Promise<ToolRunResult> {
  if (checker === "pyrefly") {
    const result = await exec({
      tool: "pyrefly",
      args: ["check", "--output-format", "json", relPath],
      cwd,
    })
    if (result.notFound) return TOOL_UNAVAILABLE
    return { available: true, diagnostics: parsePyreflyJson(result.stdout) }
  }

  const result = await exec({
    tool: "ty",
    args: ["check", "--output-format", "concise", "--color", "never", relPath],
    cwd,
  })
  if (result.notFound) return TOOL_UNAVAILABLE
  return { available: true, diagnostics: parseTyConcise(result.stdout) }
}

/**
 * Lint one file with ruff (`ruff check <file> --output-format json`). Returns the
 * typed unavailable result when ruff (or `uv`) is missing.
 */
export async function runLint(
  exec: PyToolsExec,
  relPath: string,
  cwd: string,
): Promise<ToolRunResult> {
  const result = await exec({
    tool: "ruff",
    args: ["check", relPath, "--output-format", "json"],
    cwd,
  })
  if (result.notFound) return TOOL_UNAVAILABLE
  return { available: true, diagnostics: parseRuffJson(result.stdout) }
}

/** Outcome of a format-on-save attempt: whether ruff ran, and whether it changed the file. */
export interface FormatRunResult {
  /** Whether `ruff format` was found and ran. */
  available: boolean
  /** Whether the file was reformatted (`true`) or already formatted (`false`). */
  changed: boolean
}

/**
 * Format one file in place with `ruff format <file>` (AGENTS.md "Scope", TODO
 * "Built-in editor" — format-on-save, off by default). ruff rewrites the file on
 * disk; we report whether it changed anything so the editor can reload its buffer
 * only when needed. Graceful when ruff/`uv` is absent (`available: false`).
 */
export async function runFormat(
  exec: PyToolsExec,
  relPath: string,
  cwd: string,
): Promise<FormatRunResult> {
  const result = await exec({ tool: "ruff", args: ["format", relPath], cwd })
  if (result.notFound) return { available: false, changed: false }
  // ruff prints "1 file reformatted" vs "1 file left unchanged" to stdout; a
  // reformat is the case we report so the editor knows to reload from disk.
  const changed = /reformatted/i.test(result.stdout) || /reformatted/i.test(result.stderr)
  return { available: true, changed }
}
