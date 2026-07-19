import { type ChildProcess, spawn } from "node:child_process"

const MAX_STDERR_BYTES = 32 * 1024

export interface NonInteractiveProcessInput {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
}

export interface NonInteractiveProcessResult {
  code: number | null
  signal: NodeJS.Signals | null
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
): Buffer<ArrayBufferLike> {
  const combined = Buffer.concat([current, chunk])
  return combined.length <= MAX_STDERR_BYTES
    ? combined
    : combined.subarray(combined.length - MAX_STDERR_BYTES)
}

/**
 * Spawn a one-shot harness directly as `(file, argv)` and resolve only after
 * Node confirms the child started. Shell syntax in prompts is therefore inert.
 * Output is drained, while only a bounded stderr tail is retained for a useful
 * failure message.
 */
export function createNonInteractiveProcessRunner(
  spawnProcess: SpawnProcess,
): NonInteractiveProcessRunner {
  return (input) =>
    new Promise<StartedNonInteractiveProcess>((resolve, reject) => {
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let startSettled = false
      let complete: ((result: NonInteractiveProcessResult) => void) | null = null
      const completion = new Promise<NonInteractiveProcessResult>((resolveCompletion) => {
        complete = resolveCompletion
      })

      const child: ChildProcess = spawnProcess(input.command, input.args, {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      })

      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = appendBounded(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      child.once("spawn", () => {
        startSettled = true
        resolve({ completion })
      })
      child.once("error", (error) => {
        const message = `Unable to start ${input.command}: ${error.message}`
        if (!startSettled) {
          startSettled = true
          reject(new Error(message))
          return
        }
        complete?.({ code: null, signal: null, stderr: stderr.toString("utf8"), error: message })
      })
      // `close` follows stdio shutdown; unlike `exit`, it proves the retained
      // stderr tail includes bytes written immediately before termination.
      child.once("close", (code, signal) => {
        complete?.({ code, signal, stderr: stderr.toString("utf8"), error: null })
      })
    })
}

export const runNonInteractiveProcess: NonInteractiveProcessRunner =
  createNonInteractiveProcessRunner(spawn)
