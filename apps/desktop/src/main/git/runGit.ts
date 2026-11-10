import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/**
 * Thin, promisified wrapper around the system `git` binary. The whole git layer
 * is built on `node:child_process` so PI Lab adds **no** git dependency
 * — `git` is invoked as the user's own CLI, exactly as a
 * terminal would. Output is captured (no shell, no interpolation) and failures
 * are surfaced as a typed {@link GitError} that keeps stderr intact so callers
 * can show the real git diagnostic.
 */

/** Largest git output we buffer (status/diff on big repos can be sizeable). */
const MAX_BUFFER = 64 * 1024 * 1024

/** Default per-invocation timeout; long enough for a worktree add to finish. */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * `text` with the user name and password removed from every URL in it
 * (`https://git:TOKEN@host/…` becomes `https://host/…`), so a token in a
 * remote URL never reaches an error message or a log.
 */
export function redactUrlCredentials(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1")
}

/**
 * A failed `git` invocation. Carries the exit code and the raw stderr so the
 * message a user sees is git's own, not a generic wrapper string. Credentials
 * in URLs are removed from the message, stderr and args.
 */
export class GitError extends Error {
  /** Process exit code, or a spawn error code like "ENOENT" when git is absent. */
  readonly code: number | string | undefined
  /** Captured standard error from the failed command. */
  readonly stderr: string
  /** The argv (after `git`) that failed, for diagnostics, with URL credentials removed. */
  readonly args: readonly string[]

  constructor(args: readonly string[], code: number | string | undefined, stderr: string) {
    const safeArgs = args.map(redactUrlCredentials)
    const safeStderr = redactUrlCredentials(stderr)
    const detail = safeStderr.trim() || `git exited with ${code ?? "an unknown error"}`
    super(`git ${safeArgs.join(" ")}: ${detail}`)
    this.name = "GitError"
    this.code = code
    this.stderr = safeStderr
    this.args = safeArgs
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
  /**
   * Extra environment variables for this call, added on top of the app's own
   * environment. Leave unset to run git with the inherited environment only.
   */
  env?: Record<string, string>
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
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
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
