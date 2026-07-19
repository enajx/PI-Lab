/**
 * Headless Python diagnostics engine for the built-in editor (AGENTS.md "Scope", TODO
 * "Built-in editor"). Pure parsers + one-shot CLI runners + the injectable exec
 * seam; no UI. The diagnostics tRPC router (and the live AppContext) consume this
 * barrel; tests import the parsers/runners directly.
 */

export { parsePyreflyJson } from "./parsePyrefly"
export { parseRuffJson } from "./parseRuff"
export { parseConciseLines, parseTyConcise } from "./parseTy"
export {
  createPyToolsExec,
  livePyToolsExec,
  type PyToolCommandExec,
  type PyToolExecResult,
  type PyToolsExec,
  type PyToolsExecDependencies,
} from "./pyToolsExec"
export {
  type FormatRunResult,
  runFormat,
  runLint,
  runTypeCheck,
} from "./runners"
export type {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticSource,
  DiagnosticsResult,
  ToolRunResult,
  TypeChecker,
} from "./types"
