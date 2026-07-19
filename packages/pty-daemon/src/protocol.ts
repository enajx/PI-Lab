// Wire protocol for the PTY daemon's Unix-domain socket.
//
// Framing: newline-delimited JSON (NDJSON). Every frame is exactly one JSON
// object serialized with no embedded newlines, terminated by a single `\n`.
// A reader accumulates bytes and splits on `\n` to recover frames, which
// cleanly tolerates partial socket reads and coalesced writes.
//
// Why NDJSON over length-prefixed binary: the daemon's traffic is a small set
// of control requests plus a stream of UTF-8 terminal output. Carrying PTY
// chunks as JSON strings keeps the entire wire human-readable and trivially
// debuggable (`nc -U socket`), and the parser is a single buffer split — no
// length bookkeeping, no separate binary tail to reassemble. The cost is JSON
// string-escaping of terminal bytes, which is acceptable for the per-session
// throughput PI Lab terminals produce.
//
// Direction:
//   Request   client -> daemon  (carries a correlation `cid`)
//   Reply     daemon -> client  (echoes the originating `cid`)
//   Event     daemon -> client  (unsolicited; no `cid`)

/** Bump when a backward-incompatible change is made to the frame shapes. */
export const PROTOCOL_VERSION = 1

// ---------------------------------------------------------------------------
// Session description shared across frames.
// ---------------------------------------------------------------------------

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
}

// ---------------------------------------------------------------------------
// Requests: client -> daemon. Each carries a `cid` the daemon echoes in its reply.
// ---------------------------------------------------------------------------

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

/** Begin receiving live `data`/`exit` events for a session; replays scrollback first. */
export interface AttachRequest {
  kind: "attach"
  cid: string
  sessionId: string
}

/** Stop receiving events for a session on this connection (the session keeps running). */
export interface DetachRequest {
  kind: "detach"
  cid: string
  sessionId: string
}

export interface WriteRequest {
  kind: "write"
  cid: string
  sessionId: string
  /** Bytes to feed to the PTY's stdin, as a UTF-8 string. */
  data: string
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
  /** Defaults to SIGTERM on the daemon side when omitted. */
  signal?: string
}

export interface ListRequest {
  kind: "list"
  cid: string
}

export type ClientRequest =
  | SpawnRequest
  | AttachRequest
  | DetachRequest
  | WriteRequest
  | ResizeRequest
  | KillRequest
  | ListRequest

// ---------------------------------------------------------------------------
// Replies: daemon -> client, correlated by `cid`.
// ---------------------------------------------------------------------------

export interface SpawnReply {
  kind: "spawn-ok"
  cid: string
  session: SessionInfo
}

export interface AttachReply {
  kind: "attach-ok"
  cid: string
  session: SessionInfo
  /** Buffered scrollback replayed at attach time, as a single UTF-8 string. */
  scrollback: string
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
  | SpawnReply
  | AttachReply
  | DetachReply
  | WriteReply
  | ResizeReply
  | KillReply
  | ListReply
  | ErrorReply

// ---------------------------------------------------------------------------
// Events: daemon -> client, unsolicited (sent to every attached connection).
// ---------------------------------------------------------------------------

export interface DataEvent {
  kind: "data"
  sessionId: string
  /** A chunk of PTY output, as a UTF-8 string. */
  chunk: string
}

export interface ExitEvent {
  kind: "exit"
  sessionId: string
  exitCode: number | null
  signal: number | null
}

export type DaemonEvent = DataEvent | ExitEvent

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
    case "attach":
      if (typeof value.sessionId !== "string") return null
      return { kind: "attach", cid, sessionId: value.sessionId }
    case "detach":
      if (typeof value.sessionId !== "string") return null
      return { kind: "detach", cid, sessionId: value.sessionId }
    case "write":
      if (typeof value.sessionId !== "string" || typeof value.data !== "string") return null
      return { kind: "write", cid, sessionId: value.sessionId, data: value.data }
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
    case "spawn-ok":
    case "attach-ok":
    case "detach-ok":
    case "write-ok":
    case "resize-ok":
    case "kill-ok":
    case "list-ok":
    case "error":
      return typeof value.cid === "string" ? (value as unknown as DaemonReply) : null
    case "data":
      return typeof value.sessionId === "string" && typeof value.chunk === "string"
        ? (value as unknown as DataEvent)
        : null
    case "exit":
      return typeof value.sessionId === "string" ? (value as unknown as ExitEvent) : null
    default:
      return null
  }
}
