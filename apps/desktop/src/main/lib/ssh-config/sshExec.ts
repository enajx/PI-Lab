import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/**
 * Result of probing a machine's reachability over the `ssh` CLI. Never throws —
 * an unreachable host, refused connection, or timeout is a normal, expected
 * outcome surfaced as `{ ok: false }` with a human-readable detail, so the
 * router can record it on the row and the card can render it.
 */
export interface SshProbeResult {
  ok: boolean
  /** Trimmed remote output on success, or the error message on failure. */
  detail: string
}

/**
 * Probe one host's reachability. Injected into the cluster router's context as
 * {@link SshExec} so tests can substitute a deterministic fake and never touch
 * the network (AGENTS.md §14); this is the live path the app wires in.
 *
 * Uses batch-mode ssh so it fails fast instead of blocking on a password / host-
 * key prompt, with a short connect timeout. We run `uptime` (cheap, ubiquitous)
 * and treat any clean exit as reachable.
 */
export type SshExec = (host: string) => Promise<SshProbeResult>

/** ssh options that make a probe fail fast rather than hang on a prompt. */
const SSH_PROBE_ARGS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=5",
  "-o",
  "StrictHostKeyChecking=accept-new",
]

/** Hard ceiling so a wedged connection can't keep the probe alive indefinitely. */
const PROBE_TIMEOUT_MS = 10_000

/** Keep recorded detail short — it's a status hint, not a log. */
const MAX_DETAIL_LENGTH = 200

function clampDetail(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MAX_DETAIL_LENGTH ? `${trimmed.slice(0, MAX_DETAIL_LENGTH)}…` : trimmed
}

/**
 * The live ssh probe (AGENTS.md §8): `ssh -o BatchMode=yes … <host> uptime`.
 * Resolves to a typed result either way; the only thing that can vary is the
 * detail text.
 */
export const liveSshExec: SshExec = async (host) => {
  try {
    const { stdout } = await execFileAsync("ssh", [...SSH_PROBE_ARGS, host, "uptime"], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    })
    return { ok: true, detail: clampDetail(stdout) || "reachable" }
  } catch (error) {
    const message = error instanceof Error ? error.message : "ssh probe failed"
    return { ok: false, detail: clampDetail(message) || "unreachable" }
  }
}
