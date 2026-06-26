import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** Per-GPU telemetry parsed from one reachable host's `nvidia-smi` snapshot. */
export interface GpuSnapshot {
  /** The card's `nvidia-smi` index (0-based). */
  index: number
  /** Product name, e.g. "NVIDIA A100-SXM4-80GB". */
  name: string
  /** Compute utilization, percent (0–100). */
  utilization: number
  /** Used framebuffer memory, MiB. */
  memUsed: number
  /** Total framebuffer memory, MiB. */
  memTotal: number
}

/**
 * Result of probing a machine over the `ssh` CLI. Never throws — an unreachable
 * host, refused connection, or timeout is a normal, expected outcome surfaced as
 * `{ ok: false }` with a human-readable detail, so the router can record
 * reachability on the row and the card can render it.
 *
 * Beyond reachability the probe also collects **transient** telemetry from the
 * reachable host — per-GPU usage from `nvidia-smi` and an overall CPU-busy
 * percentage. This is point-in-time and deliberately *not* persisted (it ages
 * the moment it's read); the router threads it to the UI in the mutation result
 * only, the DB keeps just reachability. A reachable host with no `nvidia-smi`
 * yields `gpus: []` rather than failing.
 */
export interface SshProbeResult {
  ok: boolean
  /** Trimmed reachability output on success, or the error message on failure. */
  detail: string
  /** Per-GPU snapshot; empty when reachable but no `nvidia-smi` / no GPUs. */
  gpus?: GpuSnapshot[]
  /** Overall CPU-busy percentage (0–100) when it could be read, else undefined. */
  cpuUsage?: number
}

/**
 * Probe one host: reachability **plus** transient GPU / CPU telemetry, in a
 * single ssh invocation. Injected into the cluster router's context as
 * {@link SshExec} so tests can substitute a deterministic fake and never touch
 * the network (docs/testing-and-build.md); this is the live path the app wires in.
 *
 * Uses batch-mode ssh so it fails fast instead of blocking on a password / host-
 * key prompt, with a short connect timeout. Any clean exit is treated as
 * reachable; the telemetry is best-effort on top.
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
const PROBE_TIMEOUT_MS = 12_000

/** Keep recorded detail short — it's a status hint, not a log. */
const MAX_DETAIL_LENGTH = 200

// Sentinel markers fence each section's output so parsing survives login noise
// (MOTD, ~/.bashrc echoes, stray CSV-shaped lines): only text *between* a pair
// of markers is from the command we ran, everything else is ignored.
const UP_START = "__SKIPPER_UP_START__"
const UP_END = "__SKIPPER_UP_END__"
const GPU_START = "__SKIPPER_GPU_START__"
const GPU_END = "__SKIPPER_GPU_END__"
const CPU_START = "__SKIPPER_CPU_START__"
const CPU_END = "__SKIPPER_CPU_END__"

/**
 * One remote command run in a fresh login shell: a sentinel-fenced `uptime` (the
 * reachability proof), then a sentinel-fenced `nvidia-smi` CSV, then a
 * sentinel-fenced CPU read. Fencing every section keeps MOTD / login-banner
 * noise out of the parsed values. Each section tolerates a missing tool
 * (`|| true` / `2>/dev/null`) so a box without `nvidia-smi` still reports
 * reachable with no GPUs.
 */
const PROBE_COMMAND = [
  `echo ${UP_START}`,
  "uptime",
  `echo ${UP_END}`,
  `echo ${GPU_START}`,
  "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null || true",
  `echo ${GPU_END}`,
  `echo ${CPU_START}`,
  // Sample /proc/stat twice ~200ms apart and report the busy percentage; quietly
  // produce nothing if /proc/stat is absent (e.g. macOS) so the section is empty.
  '(read _ u n s idle1 rest </proc/stat 2>/dev/null && t1=$((u+n+s+idle1)) && sleep 0.2 && read _ u n s idle2 rest </proc/stat && t2=$((u+n+s+idle2)) && dt=$((t2-t1)) && [ "$dt" -gt 0 ] && echo $(( (100*(dt-(idle2-idle1)))/dt ))) 2>/dev/null || true',
  `echo ${CPU_END}`,
].join("; ")

function clampDetail(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MAX_DETAIL_LENGTH ? `${trimmed.slice(0, MAX_DETAIL_LENGTH)}…` : trimmed
}

/** Extract the text between the last matching pair of sentinels, or "" if absent. */
function fenced(stdout: string, start: string, end: string): string {
  const from = stdout.lastIndexOf(start)
  const to = stdout.lastIndexOf(end)
  if (from < 0 || to <= from) return ""
  return stdout.slice(from + start.length, to)
}

/**
 * Parse the fenced `nvidia-smi` CSV (`index, name, utilization, mem.used,
 * mem.total`, no header / no units). Lines that don't have all five numeric
 * fields are dropped — a partial card is no card rather than a render glitch.
 */
function parseGpus(block: string): GpuSnapshot[] {
  const snapshots: GpuSnapshot[] = []
  for (const line of block.split("\n")) {
    const cells = line.split(",").map((cell) => cell.trim())
    if (cells.length < 5) continue
    const index = Number(cells[0])
    const utilization = Number(cells[2])
    const memUsed = Number(cells[3])
    const memTotal = Number(cells[4])
    const name = cells[1] ?? ""
    if (
      !name ||
      !Number.isFinite(index) ||
      !Number.isFinite(utilization) ||
      !Number.isFinite(memUsed) ||
      !Number.isFinite(memTotal)
    ) {
      continue
    }
    snapshots.push({ index, name, utilization, memUsed, memTotal })
  }
  return snapshots
}

/**
 * Parse the fenced CPU-busy percentage; undefined when the section is empty
 * (note `Number("")` is `0`, so the empty check must come first) or non-numeric.
 */
function parseCpuUsage(block: string): number | undefined {
  const trimmed = block.trim()
  if (!trimmed) return undefined
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : undefined
}

/** The fenced `uptime` line, trimmed and clamped; falls back to "reachable". */
function reachabilityDetail(stdout: string): string {
  return clampDetail(fenced(stdout, UP_START, UP_END)) || "reachable"
}

/**
 * The live ssh probe (docs/architecture.md (agent runtime)): a single
 * `ssh -o BatchMode=yes … <host> '<reachability + sentinel-fenced telemetry>'`.
 * Resolves to a typed result either way; an unreachable host loses the telemetry
 * fields, a reachable one without `nvidia-smi` reports `gpus: []`.
 */
export const liveSshExec: SshExec = async (host) => {
  try {
    const { stdout } = await execFileAsync("ssh", [...SSH_PROBE_ARGS, host, PROBE_COMMAND], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })
    return {
      ok: true,
      detail: reachabilityDetail(stdout),
      gpus: parseGpus(fenced(stdout, GPU_START, GPU_END)),
      cpuUsage: parseCpuUsage(fenced(stdout, CPU_START, CPU_END)),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "ssh probe failed"
    return { ok: false, detail: clampDetail(message) || "unreachable" }
  }
}
