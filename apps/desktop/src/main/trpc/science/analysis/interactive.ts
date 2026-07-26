import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { PythonRuntime } from "../../../python"

export type AnalysisInteractiveKind = "html" | "marimo"

export interface AnalysisInteractiveResult {
  type: AnalysisInteractiveKind
  url: string
  /** Human-readable runtime label shown alongside a live marimo notebook. */
  runtime?: string
}

export interface OpenReportInput {
  ownerId: string
  generation: number
  repoPath: string
  absPath: string
}

export interface StartMarimoInput {
  ownerId: string
  generation: number
  cwd: string
  absPath: string
  runtime: PythonRuntime
  portRange: { start: number; end: number }
}

/**
 * App-lifetime owner of interactive Analysis surfaces. The main process keeps
 * report URL grants and marimo children out of the renderer and can therefore
 * revoke/reap them even if the route or whole app disappears.
 */
export interface AnalysisInteractivePort {
  /**
   * Start a new owner generation before any filesystem/runtime await. A later
   * close tombstones this ticket so delayed startup cannot resurrect a surface.
   */
  begin(ownerId: string, leaseId: string): Promise<number>
  openReport(input: OpenReportInput): Promise<AnalysisInteractiveResult>
  startMarimo(input: StartMarimoInput): Promise<AnalysisInteractiveResult>
  close(ownerId: string, leaseId: string): Promise<void>
  dispose(): void
}

export interface MarimoLaunch {
  command: string
  args: string[]
}

/** Build the shell-free command that runs a notebook in the selected project runtime. */
export function buildMarimoLaunch(
  runtime: PythonRuntime,
  absPath: string,
  port: number,
): MarimoLaunch {
  const command = runtime.runStrategy.command
  if (!command) {
    throw new Error("No Python runtime is available for this project")
  }
  return {
    command,
    args: [
      ...runtime.runStrategy.argsPrefix,
      "-m",
      "marimo",
      "run",
      absPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--headless",
      "--no-token",
    ],
  }
}

/** Canonicalize one report asset and reject traversal or symlink escapes. */
export async function resolveReportAsset(root: string, requestedPath: string): Promise<string> {
  const canonicalRoot = await realpath(root)
  const lexical = resolve(canonicalRoot, requestedPath)
  assertPathInside(canonicalRoot, lexical)
  const canonicalAsset = await realpath(lexical)
  assertPathInside(canonicalRoot, canonicalAsset)
  return canonicalAsset
}

export function assertPathInside(root: string, candidate: string): void {
  const rel = relative(root, candidate)
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return
  throw new Error("Path escapes its allowed directory")
}

/** Remove an owner resource only if a newer generation has not replaced it. */
export function removeIfCurrent<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.get(key) === value) map.delete(key)
}

/**
 * Release an owner only when the caller still holds its current preview lease.
 * A cleanup request from a replaced renderer effect must never reap the newer
 * report or marimo process that reused the same owner.
 */
export function releaseLeaseIfCurrent(
  leases: Map<string, string>,
  ownerId: string,
  leaseId: string,
): boolean {
  if (leases.get(ownerId) !== leaseId) return false
  leases.delete(ownerId)
  return true
}
