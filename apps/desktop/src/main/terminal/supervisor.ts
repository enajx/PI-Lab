import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { connect } from "node:net"
import { join } from "node:path"
import { DaemonClient } from "@skipper/pty-daemon"
import { resolveDaemonSocketPath } from "./socketPath"

/**
 * Keeps exactly one PTY daemon reachable for the lifetime of the app.
 *
 * The daemon is a *separate, detached* process on purpose (AGENTS.md §6): live
 * terminals and agent sessions must outlive an Electron reload or a full app
 * quit, so the supervisor never owns the daemon's lifecycle — it only ensures
 * one is listening and holds a client to it.
 *
 * Adopt-or-spawn:
 *   - If something is already listening on the resolved socket (a daemon a prior
 *     run left detached), ADOPT it: just connect a client.
 *   - Otherwise SPAWN one as a detached child (`detached: true` + `unref()`) so
 *     it survives this process exiting, wait for its socket, then connect.
 *
 * On an unexpected client disconnect (the daemon died, or the socket dropped),
 * the supervisor reconnects with backoff — re-running adopt-or-spawn — so a
 * crashed daemon is transparently replaced while sessions that were spawned
 * before the crash are gone but the app keeps working.
 */

/** How the daemon child is launched (so tests can assert without spawning). */
export interface SpawnPlan {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export interface SupervisorOptions {
  /** Socket to adopt/serve on. Defaults to {@link resolveDaemonSocketPath}. */
  socketPath?: string
  /**
   * Absolute path of the bundled daemon entry to run as a child. Defaults to
   * `out/pty-daemon/index.js` next to the compiled main bundle.
   */
  daemonEntry?: string
  /** Milliseconds to wait for a freshly-spawned daemon's socket to appear. */
  spawnTimeoutMs?: number
  /** Base backoff between reconnect attempts after an unexpected disconnect. */
  reconnectBaseMs?: number
  /** Cap on reconnect backoff. */
  reconnectMaxMs?: number
}

const DEFAULT_SPAWN_TIMEOUT_MS = 5_000
const DEFAULT_RECONNECT_BASE_MS = 200
const DEFAULT_RECONNECT_MAX_MS = 3_000

/**
 * Resolve the bundled daemon entry. electron-vite emits the daemon bundle to
 * `out/pty-daemon/index.js`; the compiled main lives at `out/main/index.js`, so
 * the sibling directory is one level up from `__dirname`.
 */
export function resolveDaemonEntry(): string {
  return join(__dirname, "..", "pty-daemon", "index.js")
}

/**
 * Plan the child launch. We run the daemon with the *current executable* in
 * pure-Node mode (`ELECTRON_RUN_AS_NODE=1`): Electron's bundled Node executes
 * the bundle as a plain Node process, which is the ABI node-pty is prebuilt for
 * here (Node ABI 137). Using `process.execPath` avoids depending on a system
 * `node` being on PATH in the packaged app. The socket path is passed both as an
 * explicit argv (the daemon's `resolveSocketPath` prefers it) and via the env so
 * the child is unambiguous.
 */
export function planDaemonSpawn(daemonEntry: string, socketPath: string): SpawnPlan {
  return {
    command: process.execPath,
    args: [daemonEntry, socketPath],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      SKIPPER_SOCKET_PATH: socketPath,
    },
  }
}

/** Probe whether a daemon is already accepting connections on `socketPath`. */
export function isDaemonListening(socketPath: string): Promise<boolean> {
  // A bound Unix socket file with nothing listening would refuse the connect,
  // so an actual connect attempt — not an `existsSync` check — is the only
  // reliable liveness probe.
  return new Promise((resolve) => {
    const probe = connect(socketPath)
    const settle = (listening: boolean) => {
      probe.removeAllListeners()
      probe.destroy()
      resolve(listening)
    }
    probe.once("connect", () => settle(true))
    probe.once("error", () => settle(false))
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })
}

export class TerminalSupervisor {
  private readonly socketPath: string
  private readonly daemonEntry: string
  private readonly spawnTimeoutMs: number
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number

  private client: DaemonClient | null = null
  private starting: Promise<DaemonClient> | null = null
  private disposed = false
  private reconnecting = false

  constructor(options: SupervisorOptions = {}) {
    this.socketPath = options.socketPath ?? resolveDaemonSocketPath()
    this.daemonEntry = options.daemonEntry ?? resolveDaemonEntry()
    this.spawnTimeoutMs = options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS
  }

  /**
   * Ensure a daemon is reachable and return a connected client. Idempotent and
   * concurrency-safe: overlapping callers share the same in-flight start.
   */
  ensureClient(): Promise<DaemonClient> {
    if (this.disposed) return Promise.reject(new Error("supervisor disposed"))
    if (this.client) return Promise.resolve(this.client)
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async start(): Promise<DaemonClient> {
    if (!(await isDaemonListening(this.socketPath))) {
      await this.spawnDaemon()
    }
    const client = new DaemonClient(this.socketPath)
    await client.connect()
    this.client = client
    client.on("close", () => this.handleClose())
    return client
  }

  private async spawnDaemon(): Promise<void> {
    if (!existsSync(this.daemonEntry)) {
      throw new Error(
        `pty-daemon bundle not found at ${this.daemonEntry} — run the desktop build (out/pty-daemon/index.js)`,
      )
    }
    const plan = planDaemonSpawn(this.daemonEntry, this.socketPath)
    const child = spawn(plan.command, plan.args, {
      env: plan.env,
      // Detached + unref so the daemon (and its terminals) survive this process
      // exiting. stdio ignored so it has no dependency on our pipes staying open.
      detached: true,
      stdio: "ignore",
    })
    child.unref()

    // Wait for the freshly-spawned daemon to start accepting connections, or for
    // the child to die early. Poll the socket rather than sleep a fixed time.
    const deadline = Date.now() + this.spawnTimeoutMs
    let exited = false
    child.once("exit", () => {
      exited = true
    })
    while (Date.now() < deadline) {
      if (exited) throw new Error("pty-daemon child exited before it began listening")
      if (await isDaemonListening(this.socketPath)) return
      await delay(50)
    }
    throw new Error(
      `pty-daemon did not start listening on ${this.socketPath} within ${this.spawnTimeoutMs}ms`,
    )
  }

  /**
   * The client's socket closed unexpectedly. Drop it and reconnect with backoff
   * (re-running adopt-or-spawn each attempt) until we succeed or are disposed.
   */
  private handleClose(): void {
    this.client = null
    if (this.disposed || this.reconnecting) return
    this.reconnecting = true
    void this.reconnectLoop()
  }

  private async reconnectLoop(): Promise<void> {
    let attempt = 0
    while (!this.disposed && !this.client) {
      const backoff = Math.min(this.reconnectBaseMs * 2 ** attempt, this.reconnectMaxMs)
      await delay(backoff)
      if (this.disposed) break
      attempt += 1
      try {
        await this.ensureClient()
      } catch {
        // Keep retrying; a daemon may not be back yet.
      }
    }
    this.reconnecting = false
  }

  /** The socket this supervisor uses (for diagnostics/tests). */
  getSocketPath(): string {
    return this.socketPath
  }

  /**
   * Tear down the *supervisor*, not the daemon. We close our client but
   * deliberately leave the detached daemon running so sessions survive the app
   * quitting — that is the entire reason the daemon is a separate process.
   */
  dispose(): void {
    this.disposed = true
    this.client?.close()
    this.client = null
  }
}
