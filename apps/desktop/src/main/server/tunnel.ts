import { type ChildProcess, spawn } from "node:child_process"
import { connect, createServer } from "node:net"
import { posix } from "node:path"
import { DISCOVERY_FILE, type ServerDiscovery } from "../../server/access"

/**
 * SSH transport to a remote PI Lab server. The remote server listens on
 * 127.0.0.1 only; the app runs the system `ssh` (so the user's ~/.ssh/config
 * applies, including hosts reached over Tailscale) with a local port forward
 * to it. No token handling here.
 */

/** The system ssh client. */
export const SSH_PATH = "/usr/bin/ssh"

export type TunnelState = "connecting" | "open" | "reconnecting" | "closed"

export interface TunnelOptions {
  /** ssh destination: a host name, a `user@host`, or a Host alias from ~/.ssh/config. */
  host: string
  /** Port of the server on the remote machine's 127.0.0.1. */
  remotePort: number
  sshPath: string
  /** Extra ssh options placed before the host. Production passes none; tests point ssh at a test sshd. */
  extraSshArgs: string[]
  serverAliveIntervalSeconds: number
  serverAliveCountMax: number
  /** How long one ssh start may take before the local port accepts connections. */
  openTimeoutMs: number
  /** Wait before each restart after ssh exits unexpectedly; doubles up to `maxMs`. */
  backoff: { initialMs: number; maxMs: number }
  /** Called on every state change with the current local port (it can change on reconnect). */
  onState: (state: TunnelState, localPort: number) => void
  log: (message: string) => void
}

const POLL_MS = 100
const STOP_GRACE_MS = 2_000

/** A free TCP port on 127.0.0.1. */
async function freeLocalPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("listen(0) gave no port")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

/** True when nothing listens on 127.0.0.1:`port`. Errors other than "in use" are thrown. */
async function portFree(port: number): Promise<boolean> {
  const server = createServer()
  const free = await new Promise<boolean>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false)
      else reject(error)
    })
    server.listen(port, "127.0.0.1", () => resolve(true))
  })
  if (free) await new Promise<void>((resolve) => server.close(() => resolve()))
  return free
}

/** True when 127.0.0.1:`port` accepts a TCP connection. */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => {
      socket.destroy()
      resolve(false)
    })
  })
}

function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

/**
 * A local port forward `127.0.0.1:<localPort>` → `127.0.0.1:<remotePort>` on
 * `host`, kept up by restarting ssh with backoff when it exits unexpectedly
 * (killed, network change). A restart keeps the same local port when it is
 * still free, so client URLs stay valid; otherwise it picks a new one and
 * reports it through `onState`.
 */
export class SshTunnel {
  private readonly options: TunnelOptions
  private port: number
  private current: TunnelState = "closed"
  private child: ChildProcess | null = null
  private closing = false
  private closed: Promise<void> | null = null
  private wake: (() => void) | null = null
  private wakeTimer: NodeJS.Timeout | null = null

  private constructor(options: TunnelOptions, port: number) {
    this.options = options
    this.port = port
  }

  /** Start ssh and resolve once the local port accepts connections; reject with ssh's stderr. */
  static async open(options: TunnelOptions): Promise<SshTunnel> {
    const tunnel = new SshTunnel(options, await freeLocalPort())
    tunnel.setState("connecting")
    await tunnel.startSsh().catch((error: Error) => {
      tunnel.closing = true
      tunnel.setState("closed")
      throw error
    })
    tunnel.setState("open")
    return tunnel
  }

  get localPort(): number {
    return this.port
  }

  get state(): TunnelState {
    return this.current
  }

  /** pid of the running ssh, or null between restarts. */
  get pid(): number | null {
    return this.child?.pid ?? null
  }

  /** Stop ssh and any pending restart. Safe to call more than once. */
  close(): Promise<void> {
    if (this.closed === null) this.closed = this.stop()
    return this.closed
  }

  private async stop(): Promise<void> {
    this.closing = true
    if (this.wakeTimer !== null) clearTimeout(this.wakeTimer)
    this.wake?.()
    const child = this.child
    if (child !== null && running(child)) {
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS)
        child.once("exit", () => {
          clearTimeout(force)
          resolve()
        })
        child.kill("SIGTERM")
      })
    }
    this.child = null
    this.setState("closed")
  }

  private setState(state: TunnelState): void {
    this.current = state
    this.options.onState(state, this.port)
  }

  private sshArgs(): string[] {
    const o = this.options
    return [
      "-N",
      "-T",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      `ServerAliveInterval=${o.serverAliveIntervalSeconds}`,
      "-o",
      `ServerAliveCountMax=${o.serverAliveCountMax}`,
      "-o",
      "BatchMode=yes",
      "-L",
      `127.0.0.1:${this.port}:127.0.0.1:${o.remotePort}`,
      ...o.extraSshArgs,
      o.host,
    ]
  }

  /**
   * Spawn ssh and resolve once the local port accepts connections. Rejects
   * with ssh's stderr when ssh exits first or the open timeout passes (then
   * ssh is killed). After it opens, an exit not caused by close() starts the
   * reconnect loop.
   */
  private startSsh(): Promise<void> {
    const { host, sshPath, openTimeoutMs } = this.options
    const child = spawn(sshPath, this.sshArgs(), { stdio: ["ignore", "ignore", "pipe"] })
    this.child = child
    let stderr = ""
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    let opened = false
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (message: string): void => {
        settled = true
        reject(new Error(`${message}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`))
      }
      child.once("error", (error) => {
        if (!settled) fail(`could not run ${sshPath}: ${error.message}`)
      })
      child.once("exit", (code, signal) => {
        if (!opened) {
          if (!settled)
            fail(`ssh to ${host} exited (${signal ?? `code ${code}`}) before the tunnel opened`)
          return
        }
        if (this.closing || this.child !== child) return
        this.options.log(
          `ssh tunnel to ${host} exited (${signal ?? `code ${code}`}): ${stderr.trim()}`,
        )
        this.child = null
        this.setState("reconnecting")
        void this.reconnect()
      })
      const deadline = Date.now() + openTimeoutMs
      const poll = async (): Promise<void> => {
        while (!settled) {
          if (await accepts(this.port)) {
            if (settled) return
            if (!running(child)) return
            opened = true
            settled = true
            resolve()
            return
          }
          if (Date.now() > deadline) {
            child.kill("SIGKILL")
            fail(`ssh to ${host} did not open the tunnel within ${openTimeoutMs} ms`)
            return
          }
          await new Promise((r) => setTimeout(r, POLL_MS))
        }
      }
      void poll()
    })
  }

  /** Wait `ms`, or less if close() is called. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve
      this.wakeTimer = setTimeout(resolve, ms)
    })
  }

  /** Restart ssh with backoff until it opens or close() is called. */
  private async reconnect(): Promise<void> {
    const { host, backoff, log } = this.options
    let delay = backoff.initialMs
    while (!this.closing) {
      await this.sleep(delay)
      if (this.closing) return
      if (!(await portFree(this.port))) {
        const old = this.port
        this.port = await freeLocalPort()
        log(`ssh tunnel to ${host}: local port ${old} is taken, moving to ${this.port}`)
      }
      if (this.closing) return
      const error = await this.startSsh().then(
        () => null,
        (failure: Error) => failure,
      )
      if (this.closing) return
      if (error === null) {
        this.setState("open")
        return
      }
      log(`ssh tunnel to ${host}: reconnect failed: ${error.message}`)
      delay = Math.min(delay * 2, backoff.maxMs)
    }
  }
}

export interface RemoteDiscoveryOptions {
  sshPath: string
  host: string
  /** Extra ssh options placed before the host (tests only). */
  extraSshArgs: string[]
  /** The server's data folder on the remote machine. */
  dataDir: string
  timeoutMs: number
}

/** Quote one word for the remote POSIX shell. */
function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/** Read the remote server's `server.json` (port, pid, build) through ssh. */
export async function readRemoteDiscovery(
  options: RemoteDiscoveryOptions,
): Promise<ServerDiscovery> {
  const { sshPath, host, extraSshArgs, dataDir, timeoutMs } = options
  const path = posix.join(dataDir, DISCOVERY_FILE)
  const child = spawn(
    sshPath,
    ["-o", "BatchMode=yes", ...extraSshArgs, host, `cat -- ${shellQuote(path)}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  )
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolve({ code, signal }))
    },
  )
  clearTimeout(timer)
  const detail = stderr.trim()
  if (result.signal !== null) {
    throw new Error(`reading ${host}:${path} over ssh timed out after ${timeoutMs} ms: ${detail}`)
  }
  if (result.code === 255) throw new Error(`ssh to ${host} failed: ${detail}`)
  if (result.code !== 0) {
    if (detail.includes("No such file")) {
      throw new Error(`No server.json at ${host}:${path} (is the PI Lab server running there?)`)
    }
    throw new Error(`reading ${host}:${path} failed (code ${result.code}): ${detail}`)
  }
  const parsed: unknown = JSON.parse(stdout)
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("port" in parsed && typeof parsed.port === "number") ||
    !("pid" in parsed && typeof parsed.pid === "number") ||
    !("build" in parsed && typeof parsed.build === "string")
  ) {
    throw new Error(`${host}:${path} is not a server discovery file: ${stdout.trim()}`)
  }
  return { port: parsed.port, pid: parsed.pid, build: parsed.build }
}
