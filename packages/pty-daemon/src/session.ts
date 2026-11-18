// In-memory ownership of live PTY sessions. The store outlives any individual
// client connection: sessions keep running while no one is attached, and a
// reconnecting client resumes from its offset or starts from a screen snapshot.

import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { type IPty, spawn } from "node-pty"
import { ByteTail } from "./byteTail"
import { ECHO_ACK_DELAY_MS, type KeyInput, type ResumePoint, type SessionInfo } from "./protocol"
import { ScreenState } from "./screen"

/** How many raw PTY bytes to retain per session for replay on (re)attach. */
const DEFAULT_SCROLLBACK_BYTES = 256 * 1024

/**
 * Reads the ECHO bit of a PTY's termios (`tcgetattr` on the master fd, under
 * 1 µs). Windows has no termios, so there the flag is taken as always on.
 */
const termios: { echoEnabled(fd: number): boolean } | null =
  process.platform === "win32" ? null : createRequire(import.meta.url)("@pi-lab/pty-termios")

/** A replay at most this long is sent without comparing it with a screen refresh. */
export const SMALL_REPLAY_BYTES = 16 * 1024

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
  /** Raw PTY bytes; `offset` is the offset of the first one. */
  onData(bytes: Buffer, offset: number): void
  /** The PTY was resized after every byte before `offset`. */
  onResize(cols: number, rows: number, revision: number, offset: number): void
  /** The PTY's ECHO flag changed; it applies at `offset`. */
  onEcho(echo: boolean, offset: number): void
  /** A typed key's echo ack, {@link ECHO_ACK_DELAY_MS} after it was written. */
  onEchoAck(key: KeyInput, offset: number, echo: boolean): void
  onExit(exitCode: number | null, signal: number | null): void
}

/** How an attach starts, with raw bytes; see `AttachStartFrame` in the protocol. */
export type SessionStart =
  | { mode: "replay"; offset: number; bytes: Buffer }
  | { mode: "snapshot"; offset: number; screen: string; bytes: Buffer }
  | { mode: "refresh"; base: ResumePoint; offset: number; screen: string; bytes: Buffer }

interface ExitState {
  exitCode: number | null
  signal: number | null
}

/**
 * A single PTY plus its byte tail, headless emulator and subscribers.
 *
 * The byte offset counts raw PTY bytes since spawn. The revision changes when
 * the screen changes without new bytes (a resize); `revisionOffset` is the
 * offset at which the current revision began.
 */
class Session {
  readonly id = randomUUID()
  readonly command: string
  readonly args: string[]
  readonly cwd: string
  readonly createdAt = Date.now()

  private readonly pty: IPty
  private readonly processGroupId: number
  private readonly tail: ByteTail
  private readonly screen: ScreenState
  private revision = 0
  private revisionOffset = 0
  private disposed = false
  private cols: number
  private rows: number
  private exitState: ExitState | null = null
  private readonly listeners = new Set<SessionListener>()
  /** The PTY's ECHO flag as last read. */
  private echoFlag = true
  /** Set once reading the flag failed (logged); the flag then stays as it was. */
  private echoUnreadable = false

  constructor(
    options: SpawnOptions,
    scrollbackCap: number,
    readonly generation: string,
  ) {
    this.command = options.command
    this.args = options.args ?? []
    this.cwd = options.cwd ?? process.cwd()
    this.cols = options.cols ?? 80
    this.rows = options.rows ?? 24
    this.tail = new ByteTail(scrollbackCap)
    this.screen = new ScreenState(this.cols, this.rows, scrollbackCap, (heldBytes) =>
      console.warn(
        `[pty-daemon] session ${this.id}: parser reset after ${heldBytes} bytes inside one sequence`,
      ),
    )

    const inheritedEnv = { ...process.env }
    delete inheritedEnv.ELECTRON_RUN_AS_NODE
    delete inheritedEnv.PI_LAB_SOCKET_PATH
    this.pty = spawn(this.command, this.args, {
      name: "xterm-color",
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: { ...(inheritedEnv as Record<string, string>), ...options.env },
      // Raw bytes: offsets, retention and replay count PTY bytes, not decoded text.
      encoding: null,
    })

    this.processGroupId = this.pty.pid
    if (process.platform !== "win32") setUtf8LineEditing(this.pty)
    this.echoFlag = this.readEcho()

    this.pty.onData((data) => {
      // With `encoding: null` node-pty delivers Buffers despite its string typing.
      const bytes = data as unknown as Buffer
      // Output that a killed PTY flushes after teardown has nowhere to go.
      if (this.disposed) return
      const offset = this.tail.end
      // Echo turned off before this output was read (a password prompt): off from its start.
      const echo = this.readEcho()
      if (!echo && this.echoFlag) this.setEcho(false, offset)
      this.tail.append(bytes)
      this.screen.feed(bytes)
      for (const listener of this.listeners) listener.onData(bytes, offset)
      // Turned on again: on only after this output.
      if (echo && !this.echoFlag) this.setEcho(true, this.tail.end)
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
      foregroundProcess: this.alive ? this.pty.process : null,
    }
  }

  /**
   * How a client at `resume` starts, smallest first:
   * 1. replay, when the point is in this generation, at the current revision
   *    (no resize since), still retained, and the replay is at most
   *    {@link SMALL_REPLAY_BYTES} or the size of a refresh;
   * 2. refresh (the current screen over the client's own history), when the
   *    generation matches, at most one resize happened since the client's
   *    revision, the normal buffer's history did not change after the
   *    client's offset (so the client's history is already right), and its
   *    first visible row does not continue a history line;
   * 3. otherwise a snapshot.
   */
  startFrom(resume: ResumePoint | null): SessionStart {
    if (resume === null || resume.generation !== this.generation || resume.offset > this.tail.end)
      return { mode: "snapshot", ...this.screen.snapshot() }
    const replay =
      resume.revision === this.revision && resume.offset >= this.revisionOffset
        ? this.tail.from(resume.offset)
        : null
    if (replay !== null && replay.length <= SMALL_REPLAY_BYTES)
      return { mode: "replay", offset: resume.offset, bytes: replay }
    const refreshable =
      resume.revision <= this.revision &&
      this.revision - resume.revision <= 1 &&
      resume.offset >= this.screen.historyStableFrom &&
      !this.screen.firstRowContinuesHistory()
    if (!refreshable) return { mode: "snapshot", ...this.screen.snapshot() }
    const refresh = this.screen.refresh()
    if (replay !== null && replay.length <= refresh.screen.length + refresh.bytes.length)
      return { mode: "replay", offset: resume.offset, bytes: replay }
    return { mode: "refresh", base: resume, ...refresh }
  }

  get screenRevision(): number {
    return this.revision
  }

  /** The PTY's ECHO flag as last sent to listeners. */
  get echo(): boolean {
    return this.echoFlag
  }

  /**
   * Read the ECHO flag from the PTY master. A failed read (the PTY is closing)
   * is logged once; the last value is kept.
   */
  private readEcho(): boolean {
    if (termios === null || this.echoUnreadable || this.disposed || !this.alive)
      return this.echoFlag
    const fd = (this.pty as IPty & { fd?: number }).fd
    if (typeof fd !== "number") throw new Error("node-pty did not expose the PTY master fd")
    try {
      return termios.echoEnabled(fd)
    } catch (error) {
      this.echoUnreadable = true
      console.warn(
        `[pty-daemon] session ${this.id}: cannot read the ECHO flag (${error instanceof Error ? error.message : String(error)}); keeping ${this.echoFlag ? "on" : "off"}`,
      )
      return this.echoFlag
    }
  }

  private setEcho(echo: boolean, offset: number): void {
    this.echoFlag = echo
    for (const listener of this.listeners) listener.onEcho(echo, offset)
  }

  /**
   * Register a listener. If the session has
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

  /** Write to the PTY; a typed key (`key` set) gets an echo ack. */
  write(data: string, key: KeyInput | null): void {
    if (!this.alive) return
    // A program may turn echo off without printing anything (read -s).
    const echo = this.readEcho()
    if (echo !== this.echoFlag) this.setEcho(echo, this.tail.end)
    this.pty.write(data)
    if (key === null) return
    setTimeout(() => {
      if (this.disposed) return
      const now = this.readEcho()
      if (now !== this.echoFlag) this.setEcho(now, this.tail.end)
      for (const listener of this.listeners) listener.onEchoAck(key, this.tail.end, this.echoFlag)
    }, ECHO_ACK_DELAY_MS).unref()
  }

  resize(cols: number, rows: number): void {
    const changed = cols !== this.cols || rows !== this.rows
    this.cols = cols
    this.rows = rows
    if (this.alive) this.pty.resize(cols, rows)
    if (!changed) return
    this.revision += 1
    this.revisionOffset = this.tail.end
    this.screen.resize(cols, rows)
    // A client that applied less output resizes a different screen, so its history may differ.
    this.screen.historyStableFrom = Math.max(this.screen.historyStableFrom, this.tail.end)
    for (const listener of this.listeners)
      listener.onResize(cols, rows, this.revision, this.revisionOffset)
  }

  kill(signal?: string): void {
    if (!this.alive) return
    if (process.platform === "win32") {
      this.pty.kill(signal)
      return
    }
    // Match node-pty's terminal hangup default: interactive shells ignore SIGTERM.
    // Include the process group so agent subprocesses receive the same signal.
    try {
      process.kill(-this.processGroupId, (signal ?? "SIGHUP") as NodeJS.Signals)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // macOS can report EPERM for a group already exiting before onExit fires.
      // The original PTY kill handles that teardown race without a group lookup.
      if (code === "EPERM") this.pty.kill(signal)
      else if (code !== "ESRCH") throw error
    }
  }

  /** Drop all listeners and the emulator; used when the session is reaped. */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.screen.dispose()
  }
}

/** A handle the server uses to drive one session without touching internals. */
export interface SessionHandle {
  readonly id: string
  readonly generation: string
  readonly screenRevision: number
  readonly echo: boolean
  info(): SessionInfo
  startFrom(resume: ResumePoint | null): SessionStart
  subscribe(listener: SessionListener): () => void
  write(data: string, key: KeyInput | null): void
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
  /** New for every daemon process, so a resume point from another daemon never replays. */
  readonly generation = randomUUID()
  private readonly sessions = new Map<string, Session>()
  private readonly scrollbackBytes: number
  private readonly onSessionReaped?: (sessionId: string) => void

  constructor(options: SessionStoreOptions = {}) {
    this.scrollbackBytes = options.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES
    this.onSessionReaped = options.onSessionReaped
  }

  spawn(options: SpawnOptions): SessionHandle {
    const session = new Session(options, this.scrollbackBytes, this.generation)
    this.sessions.set(session.id, session)
    // Reap from the map once the PTY exits, but only after a short grace period
    // so a client attaching right after exit still finds the session and its
    // final scrollback. Listeners always receive the exit event regardless.
    session.subscribe({
      onData: () => {},
      onResize: () => {},
      onEcho: () => {},
      onEchoAck: () => {},
      onExit: () => {
        setTimeout(() => {
          if (this.sessions.get(session.id) === session) {
            this.sessions.delete(session.id)
            session.dispose()
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
      session.dispose()
    }
    this.sessions.clear()
  }
}

/**
 * node-pty sets the IUTF8 terminal flag only for `encoding: "utf8"`. Raw-byte
 * output (`encoding: null`) leaves it off, so a program reading cooked-mode
 * lines would erase one byte of a non-ASCII character. Turn it on with `stty`
 * on the PTY's own device right after spawn.
 */
function setUtf8LineEditing(pty: IPty): void {
  const device = (pty as IPty & { ptsName?: string }).ptsName
  if (!device) throw new Error("node-pty did not report the PTY device name")
  const flag = process.platform === "darwin" ? "-f" : "-F"
  execFileSync("/bin/stty", [flag, device, "iutf8"], { stdio: "ignore" })
}
