import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/**
 * Thin, promisified wrapper around the system `git` binary. The whole git layer
 * is built on `node:child_process` so Skipper adds **no** git dependency
 * (docs/architecture.md) — `git` is invoked as the user's own CLI, exactly as a
 * terminal would. Output is captured (no shell, no interpolation) and failures
 * are surfaced as a typed {@link GitError} that keeps stderr intact so callers
 * can show the real git diagnostic.
 */

/** Largest git output we buffer (status/diff on big repos can be sizeable). */
const MAX_BUFFER = 64 * 1024 * 1024

/** Default per-invocation timeout; long enough for a worktree add to finish. */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * A failed `git` invocation. Carries the exit code and the raw stderr so the
 * message a user sees is git's own, not a generic wrapper string.
 */
export class GitError extends Error {
  /** Process exit code, or a spawn error code like "ENOENT" when git is absent. */
  readonly code: number | string | undefined
  /** Captured standard error from the failed command. */
  readonly stderr: string
  /** The argv (after `git`) that failed, for diagnostics. */
  readonly args: readonly string[]

  constructor(args: readonly string[], code: number | string | undefined, stderr: string) {
    const detail = stderr.trim() || `git exited with ${code ?? "an unknown error"}`
    super(`git ${args.join(" ")}: ${detail}`)
    this.name = "GitError"
    this.code = code
    this.stderr = stderr
    this.args = args
  }
}

interface GitExecError extends Error {
  code?: number | string
  stdout?: string
  stderr?: string
}

export interface RunGitOptions {
  /** Per-call timeout in ms (defaults to {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number
  /**
   * Treat a non-zero exit as success and return its output anyway. Useful for
   * commands whose "failure" exit code is informational (none used yet, but the
   * seam keeps callers from re-implementing exec).
   */
  allowFailure?: boolean
}

export interface GitResult {
  stdout: string
  stderr: string
}

/**
 * Run `git -C <cwd> <args…>` and return captured stdout/stderr. Throws
 * {@link GitError} on a non-zero exit (unless `allowFailure`), preserving git's
 * own stderr text.
 */
export async function runGit(
  cwd: string,
  args: string[],
  options: RunGitOptions = {},
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
      maxBuffer: MAX_BUFFER,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      windowsHide: true,
    })
    return { stdout, stderr }
  } catch (error) {
    const execError = error as GitExecError
    if (options.allowFailure) {
      return { stdout: execError.stdout ?? "", stderr: execError.stderr ?? "" }
    }
    throw new GitError(args, execError.code, execError.stderr ?? execError.message ?? "")
  }
}
