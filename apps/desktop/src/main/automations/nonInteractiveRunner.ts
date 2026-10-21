import { type ChildProcess, spawn } from "node:child_process"

// Stdout carries the run's user-facing output (e.g. a project summary), so it gets
// a generous cap; stderr only needs a short tail for a failure message. Both are
// bounded so a runaway harness can't grow the buffer without limit.
const MAX_STDOUT_BYTES = 1024 * 1024
const MAX_STDERR_BYTES = 32 * 1024
const TERMINATION_DRAIN_MS = 1_000

export interface NonInteractiveProcessInput {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  /**
   * Hard wall-clock cap for the run (ms). When exceeded, the child is force-killed
   * and the run resolves as a failure with a clear "timed out" message — so a
   * hung harness can never leave a caller (e.g. a background workflow) spinning
   * forever. Omitted ⇒ no timeout (the historical behavior).
   */
  timeoutMs?: number
  /**
   * Live output tap: called with each decoded `stdout`/`stderr` chunk as it
   * arrives, in addition to the bounded accumulation below. Lets a caller stream
   * the run to the UI in real time (e.g. a background workflow's live log)
   * without waiting for `completion`. Omitted ⇒ only the accumulated result is
   * observed (the historical behavior).
   */
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void
}

export interface NonInteractiveProcessResult {
  code: number | null
  signal: NodeJS.Signals | null
  /** Full captured stdout — the one-shot run's user-facing output (e.g. a summary). */
  stdout: string
  stderr: string
  error: string | null
}

export interface StartedNonInteractiveProcess {
  completion: Promise<NonInteractiveProcessResult>
}

export type NonInteractiveProcessRunner = (
  input: NonInteractiveProcessInput,
) => Promise<StartedNonInteractiveProcess>

type SpawnProcess = typeof spawn

function appendBounded(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  maxBytes: number,
): Buffer<ArrayBufferLike> {
  const combined = Buffer.concat([current, chunk])
  return combined.length <= maxBytes ? combined : combined.subarray(combined.length - maxBytes)
}

/**
 * Spawn a one-shot harness directly as `(file, argv)` and resolve only after
 * Node confirms the child started. Shell syntax in prompts is therefore inert.
 * Both streams accumulate bounded to their last N bytes — a generous cap for
 * stdout (the run's user-facing output, e.g. a project summary) and a short tail
 * for stderr (a useful failure message) — so a runaway harness can't grow memory
 * without limit.
 */
export function createNonInteractiveProcessRunner(
  spawnProcess: SpawnProcess,
): NonInteractiveProcessRunner {
  return (input) =>
    new Promise<StartedNonInteractiveProcess>((resolve, reject) => {
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let startSettled = false
      let timedOut = false
      let timeout: ReturnType<typeof setTimeout> | null = null
      let drainTimeout: ReturnType<typeof setTimeout> | null = null
      let complete: ((result: NonInteractiveProcessResult) => void) | null = null
      const completion = new Promise<NonInteractiveProcessResult>((resolveCompletion) => {
        complete = resolveCompletion
      })

      const clearTimeoutTimer = () => {
        if (timeout !== null) {
          clearTimeout(timeout)
          timeout = null
        }
        if (drainTimeout !== null) {
          clearTimeout(drainTimeout)
          drainTimeout = null
        }
      }

      const child: ChildProcess = spawnProcess(input.command, input.args, {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      })

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        stdout = appendBounded(stdout, buffer, MAX_STDOUT_BYTES)
        input.onOutput?.(buffer.toString("utf8"), "stdout")
      })
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        stderr = appendBounded(stderr, buffer, MAX_STDERR_BYTES)
        input.onOutput?.(buffer.toString("utf8"), "stderr")
      })
      child.once("spawn", () => {
        startSettled = true
        // Start the wall-clock cap only once the child is actually running, so a
        // slow spawn doesn't eat into the run's own budget. Force-kill on expiry;
        // the `close` handler below reports the timeout as a failure.
        if (input.timeoutMs !== undefined) {
          timeout = setTimeout(() => {
            timedOut = true
            if (process.platform !== "win32" && child.pid !== undefined) {
              try {
                // The group survives its leader while descendants still hold our pipes.
                process.kill(-child.pid, "SIGKILL")
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                  child.kill("SIGKILL")
                }
              }
            } else child.kill("SIGKILL")
            // A descendant can escape the group. Never wait forever for its pipes.
            drainTimeout = setTimeout(() => {
              child.stdout?.destroy()
              child.stderr?.destroy()
              complete?.({
                code: child.exitCode,
                signal: child.signalCode,
                stdout: stdout.toString("utf8"),
                stderr: stderr.toString("utf8"),
                error: `Timed out after ${input.timeoutMs}ms`,
              })
              clearTimeoutTimer()
            }, TERMINATION_DRAIN_MS)
          }, input.timeoutMs)
        }
        resolve({ completion })
      })
      child.once("error", (error) => {
        clearTimeoutTimer()
        const message = `Unable to start ${input.command}: ${error.message}`
        if (!startSettled) {
          startSettled = true
          reject(new Error(message))
          return
        }
        complete?.({
          code: null,
          signal: null,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          error: message,
        })
      })
      // `close` follows stdio shutdown; unlike `exit`, it proves the captured
      // stdout/stderr include bytes written immediately before termination.
      child.once("close", (code, signal) => {
        clearTimeoutTimer()
        complete?.({
          code,
          signal,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          error: timedOut ? `Timed out after ${input.timeoutMs}ms` : null,
        })
      })
    })
}

export const runNonInteractiveProcess: NonInteractiveProcessRunner =
  createNonInteractiveProcessRunner(spawn)
