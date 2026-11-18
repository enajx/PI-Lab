// Socket frames are newline-delimited JSON. Requests and replies share a `cid`;
// unsolicited events have none.

/** Bump when a backward-incompatible change is made to the frame shapes. */
export const PROTOCOL_VERSION = 3

export interface SessionInfo {
  /** Daemon-assigned opaque identifier, stable for the session's lifetime. */
  id: string
  command: string
  args: string[]
  cwd: string
  cols: number
  rows: number
  /** Epoch millis at spawn. */
  createdAt: number
  /** OS process id of the PTY's child, or null once it has exited. */
  pid: number | null
  /** False once the child process has exited. */
  alive: boolean
  /**
   * Name of the PTY's foreground process (a shell at its prompt reports its own
   * name), or null once exited. Absent from daemons built before this field.
   */
  foregroundProcess?: string | null
}

export interface ProcessParams {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  metadata: Record<string, string>
  timeoutMs?: number
}
export interface ProcessResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  error: string | null
}
export interface ProcessSummary {
  id: string
  metadata: Record<string, string>
  alive: boolean
}
export interface ProcessSnapshot extends ProcessSummary {
  stdoutBytes: number
  stderrBytes: number
  stdout: string
  stderr: string
  sequence: number
  result: ProcessResult | null
}
export type ProcessRequest =
  | ({ kind: "process-start"; cid: string } & ProcessParams)
  | { kind: "process-list"; cid: string }
  | { kind: "process-attach" | "process-kill" | "process-forget"; cid: string; id: string }
export type ProcessReply =
  | { kind: "process-start-ok" | "process-attach-ok"; cid: string; process: ProcessSnapshot }
  | { kind: "process-list-ok"; cid: string; processes: ProcessSummary[] }
  | { kind: "process-kill-ok" | "process-forget-ok"; cid: string }
export interface ProcessOutputEvent {
  kind: "process-output"
  offset: number
  id: string
  stream: "stdout" | "stderr"
  chunk: string
  sequence: number
}
export interface ProcessExitEvent {
  kind: "process-exit"
  id: string
  result: ProcessResult
}
export type ProcessEvent = ProcessOutputEvent | ProcessExitEvent

export interface SpawnRequest {
  kind: "spawn"
  cid: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
}

/**
 * Identity of a client's screen state: the daemon generation, the next byte its
 * emulator needs (raw PTY bytes since spawn), and the screen revision.
 */
export interface ResumePoint {
  generation: string
  offset: number
  revision: number
}

/**
 * Begin receiving live `data`/`resize`/`exit` events for a session. With a
 * resume point the daemon replays the bytes from it when it can; otherwise,
 * and on a fresh attach (`resume: null`), it sends a screen snapshot.
 */
export interface AttachRequest {
  kind: "attach"
  cid: string
  sessionId: string
  resume: ResumePoint | null
}

/** Stop receiving events for a session on this connection (the session keeps running). */
export interface DetachRequest {
  kind: "detach"
  cid: string
  sessionId: string
}

/** A key a user typed: who typed it and its number in that client's sequence. */
export interface KeyInput {
  clientId: string
  seq: number
}

export interface WriteRequest {
  kind: "write"
  cid: string
  sessionId: string
  /** Bytes to feed to the PTY's stdin, as a UTF-8 string. */
  data: string
  /** Set for typed keys: the daemon sends an {@link EchoAckEvent} for each one. */
  key?: KeyInput
}

export interface ResizeRequest {
  kind: "resize"
  cid: string
  sessionId: string
  cols: number
  rows: number
}

export interface KillRequest {
  kind: "kill"
  cid: string
  sessionId: string
  /** Defaults to SIGHUP on Unix when omitted, matching terminal hangup. */
  signal?: string
}

export interface ListRequest {
  kind: "list"
  cid: string
}

/** Stop every session and job, close the socket, and end the daemon process. */
export interface ShutdownRequest {
  kind: "shutdown"
  cid: string
}

export type ClientRequest =
  | ProcessRequest
  | SpawnRequest
  | AttachRequest
  | DetachRequest
  | WriteRequest
  | ResizeRequest
  | KillRequest
  | ListRequest
  | ShutdownRequest

// ---------------------------------------------------------------------------
// Replies: daemon -> client, correlated by `cid`.
// ---------------------------------------------------------------------------

export interface SpawnReply {
  kind: "spawn-ok"
  cid: string
  session: SessionInfo
  /** Daemon generation; the spawning connection is attached at offset 0, revision 0. */
  generation: string
}

/**
 * How an attach starts, on the wire. Raw bytes travel as base64.
 * - replay: the bytes from the requested offset to the current offset.
 * - snapshot: a screen that contains exactly the bytes before `offset`, to be
 *   written into a reset terminal of the reply's size, then the bytes from
 *   `offset` to the current offset.
 * - refresh: only for a client at `base` (its resume point): resize to the
 *   reply's size if it differs, write `screen` (it resets the modes and
 *   replaces the visible rows, keeping the client's history), then the bytes
 *   from `offset` to the current offset.
 * Live `data` events continue from the current offset with no gap or overlap.
 */
export type AttachStartFrame =
  | { mode: "replay"; offset: number; base64: string }
  | { mode: "snapshot"; offset: number; screen: string; base64: string }
  | { mode: "refresh"; base: ResumePoint; offset: number; screen: string; base64: string }

export interface AttachReply {
  kind: "attach-ok"
  cid: string
  session: SessionInfo
  generation: string
  /** Screen revision after the start is applied. */
  revision: number
  /** The PTY's ECHO flag after the start (see {@link EchoEvent}). */
  echo: boolean
  /** Current PTY size. */
  cols: number
  rows: number
  start: AttachStartFrame
}

export interface DetachReply {
  kind: "detach-ok"
  cid: string
  sessionId: string
}

export interface WriteReply {
  kind: "write-ok"
  cid: string
  sessionId: string
}

export interface ResizeReply {
  kind: "resize-ok"
  cid: string
  sessionId: string
  cols: number
  rows: number
}

export interface KillReply {
  kind: "kill-ok"
  cid: string
  sessionId: string
}

export interface ListReply {
  kind: "list-ok"
  cid: string
  sessions: SessionInfo[]
  /** Protocol version the daemon speaks. Absent in replies from version 1 daemons. */
  protocol: number
}

/** Sent before the daemon stops its sessions and closes. */
export interface ShutdownReply {
  kind: "shutdown-ok"
  cid: string
  /** OS process id of the daemon. */
  pid: number
}

/** Correlated failure for any request that could not be served. */
export interface ErrorReply {
  kind: "error"
  cid: string
  /** Stable machine-readable code, e.g. "unknown-session" | "bad-request" | "spawn-failed". */
  code: string
  message: string
}

export type DaemonReply =
  | ProcessReply
  | SpawnReply
  | AttachReply
  | DetachReply
  | WriteReply
  | ResizeReply
  | KillReply
  | ListReply
  | ShutdownReply
  | ErrorReply

// ---------------------------------------------------------------------------
// Events: daemon -> client, unsolicited (sent to every attached connection).
// ---------------------------------------------------------------------------

/** A chunk of raw PTY output, on the wire. */
export interface DataFrame {
  kind: "data"
  sessionId: string
  generation: string
  /** Offset of the chunk's first byte (raw PTY bytes since spawn). */
  offset: number
  /** The raw bytes, base64 encoded. */
  base64: string
}

/** A chunk of raw PTY output, as the client delivers it. */
export interface DataEvent {
  kind: "data"
  sessionId: string
  generation: string
  /** Offset of the chunk's first byte (raw PTY bytes since spawn). */
  offset: number
  bytes: Buffer
}

/**
 * The PTY was resized. The screen changed without new output, so the revision
 * changed; it applies after every byte before `offset`.
 */
export interface ResizeEvent {
  kind: "resize"
  sessionId: string
  generation: string
  offset: number
  revision: number
  cols: number
  rows: number
}

/**
 * The PTY's ECHO flag changed (a program turned echo off for hidden input, or
 * back on). It applies at `offset`: off before the output read with it, on
 * after it. The daemon reads the flag on every output chunk and every write.
 */
export interface EchoEvent {
  kind: "echo"
  sessionId: string
  generation: string
  offset: number
  echo: boolean
}

/**
 * Sent {@link ECHO_ACK_DELAY_MS} after a typed key was written, with the
 * offset at that moment, so the program's echo of the key comes before it.
 * Local echo checks its predictions for keys up to `seq` once the bytes
 * before `offset` are applied.
 */
export interface EchoAckEvent {
  kind: "echo-ack"
  sessionId: string
  generation: string
  clientId: string
  seq: number
  offset: number
  echo: boolean
}

/** How long after a typed key its echo ack is sent (Mosh's ECHO_TIMEOUT). */
export const ECHO_ACK_DELAY_MS = 50

export interface ExitEvent {
  kind: "exit"
  sessionId: string
  exitCode: number | null
  signal: number | null
}

/**
 * The daemon is closing this connection (for example, the reader was too slow).
 * Sent last, after everything already queued; the sessions keep running.
 */
export interface ClosingEvent {
  kind: "closing"
  reason: string
}

export type DaemonEvent =
  | DataFrame
  | ResizeEvent
  | EchoEvent
  | EchoAckEvent
  | ExitEvent
  | ProcessEvent
  | ClosingEvent

/** Every frame the daemon can emit. */
export type DaemonFrame = DaemonReply | DaemonEvent

// ---------------------------------------------------------------------------
// Serialization helpers.
// ---------------------------------------------------------------------------

/** Serialize one frame into a single NDJSON line (including the trailing `\n`). */
export function encodeFrame(frame: ClientRequest | DaemonFrame): string {
  return `${JSON.stringify(frame)}\n`
}

/**
 * Incremental NDJSON line reader. Feed it raw socket data; it returns the
 * complete frames found so far and retains any trailing partial line for the
 * next call.
 */
export class FrameDecoder {
  private buffer = ""

  /** Append a raw chunk and yield every complete line decoded as JSON. */
  push(chunk: string): unknown[] {
    this.buffer += chunk
    const frames: unknown[] = []
    let newlineIndex = this.buffer.indexOf("\n")
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line.length > 0) frames.push(JSON.parse(line))
      newlineIndex = this.buffer.indexOf("\n")
    }
    return frames
  }
}

// ---------------------------------------------------------------------------
// Hand-written validation guards (no runtime dependency on a schema library).
// These narrow `unknown` decoded frames before the daemon/client act on them.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "string")
}

/** Validate a decoded frame as a client request, or return null if malformed. */
export function parseClientRequest(value: unknown): ClientRequest | null {
  if (!isRecord(value)) return null
  if (typeof value.cid !== "string") return null
  const cid = value.cid

  switch (value.kind) {
    case "process-start":
      if (
        typeof value.command !== "string" ||
        !isStringArray(value.args) ||
        typeof value.cwd !== "string" ||
        !isStringRecord(value.env) ||
        !isStringRecord(value.metadata)
      )
        return null
      if (
        value.timeoutMs !== undefined &&
        (typeof value.timeoutMs !== "number" ||
          !Number.isFinite(value.timeoutMs) ||
          value.timeoutMs <= 0)
      )
        return null
      return {
        kind: "process-start",
        cid,
        command: value.command,
        args: value.args,
        cwd: value.cwd,
        env: value.env,
        metadata: value.metadata,
        timeoutMs: value.timeoutMs,
      }
    case "process-list":
      return { kind: "process-list", cid }
    case "process-attach":
    case "process-kill":
    case "process-forget":
      return typeof value.id === "string" ? { kind: value.kind, cid, id: value.id } : null
    case "spawn": {
      if (typeof value.command !== "string") return null
      if (value.args !== undefined && !isStringArray(value.args)) return null
      if (value.cwd !== undefined && typeof value.cwd !== "string") return null
      if (value.env !== undefined && !isStringRecord(value.env)) return null
      if (value.cols !== undefined && typeof value.cols !== "number") return null
      if (value.rows !== undefined && typeof value.rows !== "number") return null
      return {
        kind: "spawn",
        cid,
        command: value.command,
        args: value.args,
        cwd: value.cwd,
        env: value.env,
        cols: value.cols,
        rows: value.rows,
      }
    }
    case "attach": {
      if (typeof value.sessionId !== "string") return null
      const resume = value.resume
      if (resume === null || resume === undefined)
        return { kind: "attach", cid, sessionId: value.sessionId, resume: null }
      if (
        !isRecord(resume) ||
        typeof resume.generation !== "string" ||
        !isCount(resume.offset) ||
        !isCount(resume.revision)
      )
        return null
      return {
        kind: "attach",
        cid,
        sessionId: value.sessionId,
        resume: { generation: resume.generation, offset: resume.offset, revision: resume.revision },
      }
    }
    case "detach":
      if (typeof value.sessionId !== "string") return null
      return { kind: "detach", cid, sessionId: value.sessionId }
    case "write": {
      if (typeof value.sessionId !== "string" || typeof value.data !== "string") return null
      const key = value.key
      if (key === undefined)
        return { kind: "write", cid, sessionId: value.sessionId, data: value.data }
      if (!isRecord(key) || typeof key.clientId !== "string" || !isCount(key.seq)) return null
      return {
        kind: "write",
        cid,
        sessionId: value.sessionId,
        data: value.data,
        key: { clientId: key.clientId, seq: key.seq },
      }
    }
    case "resize":
      if (typeof value.sessionId !== "string") return null
      if (typeof value.cols !== "number" || typeof value.rows !== "number") return null
      return { kind: "resize", cid, sessionId: value.sessionId, cols: value.cols, rows: value.rows }
    case "kill":
      if (typeof value.sessionId !== "string") return null
      if (value.signal !== undefined && typeof value.signal !== "string") return null
      return { kind: "kill", cid, sessionId: value.sessionId, signal: value.signal }
    case "list":
      return { kind: "list", cid }
    case "shutdown":
      return { kind: "shutdown", cid }
    default:
      return null
  }
}

/** Validate a decoded frame as a daemon frame (reply or event), or return null. */
export function parseDaemonFrame(value: unknown): DaemonFrame | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null
  // The shapes are simple and produced only by our own daemon; a kind check
  // plus the structural narrowing below is enough to keep the client honest.
  switch (value.kind) {
    case "process-output":
    case "process-exit":
      return typeof value.id === "string" ? (value as unknown as ProcessEvent) : null
    case "spawn-ok":
      // A daemon from before protocol 2 sends no generation.
      return typeof value.cid === "string" && typeof value.generation === "string"
        ? (value as unknown as SpawnReply)
        : null
    case "attach-ok":
      return typeof value.cid === "string" && isRecord(value.start)
        ? (value as unknown as AttachReply)
        : null
    case "process-start-ok":
    case "process-attach-ok":
    case "process-list-ok":
    case "process-kill-ok":
    case "process-forget-ok":
    case "detach-ok":
    case "write-ok":
    case "resize-ok":
    case "kill-ok":
    case "list-ok":
    case "shutdown-ok":
    case "error":
      return typeof value.cid === "string" ? (value as unknown as DaemonReply) : null
    case "data":
      return typeof value.sessionId === "string" &&
        isCount(value.offset) &&
        typeof value.base64 === "string"
        ? (value as unknown as DataFrame)
        : null
    case "resize":
      return typeof value.sessionId === "string" && isCount(value.offset)
        ? (value as unknown as ResizeEvent)
        : null
    case "echo-ack":
      return typeof value.sessionId === "string" &&
        typeof value.clientId === "string" &&
        isCount(value.seq) &&
        isCount(value.offset)
        ? (value as unknown as EchoAckEvent)
        : null
    case "echo":
      return typeof value.sessionId === "string" &&
        isCount(value.offset) &&
        typeof value.echo === "boolean"
        ? (value as unknown as EchoEvent)
        : null
    case "exit":
      return typeof value.sessionId === "string" ? (value as unknown as ExitEvent) : null
    case "closing":
      return typeof value.reason === "string" ? (value as unknown as ClosingEvent) : null
    default:
      return null
  }
}
