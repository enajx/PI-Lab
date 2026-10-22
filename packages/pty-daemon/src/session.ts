// In-memory ownership of live PTY sessions. The store outlives any individual
// client connection: sessions keep running while no one is attached, and a
// reconnecting client replays recent scrollback then resumes the live stream.

import { randomUUID } from "node:crypto"
import { type IPty, spawn } from "node-pty"
import type { SessionInfo } from "./protocol"
import { Scrollback } from "./scrollback"

/** How much PTY output to retain per session for replay on (re)attach. */
const DEFAULT_SCROLLBACK_BYTES = 256 * 1024

export interface SpawnOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
}

/** Listeners notified for the lifetime of a single session. */
export interface SessionListener {
  onData(chunk: string): void
  onExit(exitCode: number | null, signal: number | null): void
}

interface ExitState {
  exitCode: number | null
  signal: number | null
}

/**
 * A single PTY plus its replay buffer and subscribers.
 *
 * Scrollback retains a capped UTF-16 suffix in chunks and joins on attach.
 */
class Session {
  readonly id = randomUUID()
  readonly command: string
  readonly args: string[]
  readonly cwd: string
  readonly createdAt = Date.now()

  private readonly pty: IPty
  private readonly processGroupId: number
  private readonly scrollback: Scrollback
  private cols: number
  private rows: number
  private exitState: ExitState | null = null
  private readonly listeners = new Set<SessionListener>()

  constructor(options: SpawnOptions, scrollbackCap: number) {
    this.command = options.command
    this.args = options.args ?? []
    this.cwd = options.cwd ?? process.cwd()
    this.cols = options.cols ?? 80
    this.rows = options.rows ?? 24
    this.scrollback = new Scrollback(scrollbackCap)

    const inheritedEnv = { ...process.env }
    delete inheritedEnv.ELECTRON_RUN_AS_NODE
    delete inheritedEnv.PI_LAB_SOCKET_PATH
    this.pty = spawn(this.command, this.args, {
      name: "xterm-color",
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: { ...(inheritedEnv as Record<string, string>), ...options.env },
    })

    this.processGroupId = this.pty.pid

    this.pty.onData((chunk) => {
      this.scrollback.append(chunk)
      for (const listener of this.listeners) listener.onData(chunk)
    })

    this.pty.onExit(({ exitCode, signal }) => {
      this.exitState = { exitCode, signal: signal ?? null }
      for (const listener of this.listeners) listener.onExit(exitCode, signal ?? null)
    })
  }

  get alive(): boolean {
    return this.exitState === null
  }

  get pid(): number | null {
    return this.alive ? this.pty.pid : null
  }

  info(): SessionInfo {
    return {
      id: this.id,
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      pid: this.pid,
      alive: this.alive,
    }
  }

  getScrollback(): string {
    return this.scrollback.text()
  }

  /**
   * Register a listener and return its current scrollback. If the session has
   * already exited, the caller is notified synchronously so a late attach still
   * observes the exit. Returns an unsubscribe function.
   */
  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener)
    if (this.exitState !== null) {
      const { exitCode, signal } = this.exitState
      listener.onExit(exitCode, signal)
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  write(data: string): void {
    if (this.alive) this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    if (this.alive) this.pty.resize(cols, rows)
  }

  kill(signal?: string): void {
    if (!this.alive) return
    if (process.platform === "win32") {
      this.pty.kill(signal)
      return
    }
    // node-pty starts a new session/process group; include the agent's children.
    try {
      process.kill(-this.processGroupId, (signal ?? "SIGTERM") as NodeJS.Signals)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // macOS can report EPERM for a group already exiting before onExit fires.
      // The original PTY kill handles that teardown race without a group lookup.
      if (code === "EPERM") this.pty.kill(signal)
      else if (code !== "ESRCH") throw error
    }
  }

  /** Drop all listeners; used during store teardown. */
  clearListeners(): void {
    this.listeners.clear()
  }
}

/** A handle the server uses to drive one session without touching internals. */
export interface SessionHandle {
  readonly id: string
  info(): SessionInfo
  getScrollback(): string
  subscribe(listener: SessionListener): () => void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface SessionStoreOptions {
  scrollbackBytes?: number
  /** Invoked after a session exits and has been removed from the store. */
  onSessionReaped?: (sessionId: string) => void
}

/** Owns every live session and reaps each one shortly after its PTY exits. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>()
  private readonly scrollbackBytes: number
  private readonly onSessionReaped?: (sessionId: string) => void

  constructor(options: SessionStoreOptions = {}) {
    this.scrollbackBytes = options.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES
    this.onSessionReaped = options.onSessionReaped
  }

  spawn(options: SpawnOptions): SessionHandle {
    const session = new Session(options, this.scrollbackBytes)
    this.sessions.set(session.id, session)
    // Reap from the map once the PTY exits, but only after a short grace period
    // so a client attaching right after exit still finds the session and its
    // final scrollback. Listeners always receive the exit event regardless.
    session.subscribe({
      onData: () => {},
      onExit: () => {
        setTimeout(() => {
          if (this.sessions.get(session.id) === session) {
            this.sessions.delete(session.id)
            session.clearListeners()
            this.onSessionReaped?.(session.id)
          }
        }, 5_000).unref?.()
      },
    })
    return session
  }

  get(sessionId: string): SessionHandle | undefined {
    return this.sessions.get(sessionId)
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values(), (session) => session.info())
  }

  /** Kill and drop every session. Used on daemon shutdown. */
  shutdown(): void {
    for (const session of this.sessions.values()) {
      session.kill("SIGKILL")
      session.clearListeners()
    }
    this.sessions.clear()
  }
}
