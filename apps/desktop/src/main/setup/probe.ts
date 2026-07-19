import { execFile } from "node:child_process"

const MAX_OUTPUT_BYTES = 32 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

export interface SetupProbeInput {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface SetupProbeOutput {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type SetupProbe = (input: SetupProbeInput) => Promise<SetupProbeOutput>

type ExecFile = typeof execFile

function bounded(value: string): string {
  const bytes = Buffer.from(value)
  return bytes.length <= MAX_OUTPUT_BYTES
    ? value
    : bytes.subarray(bytes.length - MAX_OUTPUT_BYTES).toString("utf8")
}

/**
 * Run a status command as an exact executable/argv tuple. The setup router
 * parses only allowlisted fields and known phrases from this bounded result;
 * raw output never crosses into the renderer.
 */
export function createSetupProbe(exec: ExecFile, timeoutMs: number): SetupProbe {
  return (input) =>
    new Promise<SetupProbeOutput>((resolve) => {
      exec(
        input.command,
        input.args,
        {
          env: input.env,
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const execError = error as NodeJS.ErrnoException & {
            code?: string | number
            killed?: boolean
          }
          resolve({
            code: typeof execError?.code === "number" ? execError.code : error ? null : 0,
            stdout: bounded(String(stdout)),
            stderr: bounded(String(stderr)),
            timedOut: Boolean(error && (execError.killed || execError.code === "ETIMEDOUT")),
          })
        },
      )
    })
}

export const liveSetupProbe: SetupProbe = createSetupProbe(execFile, DEFAULT_TIMEOUT_MS)
