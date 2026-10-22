// Socket frames are newline-delimited JSON. Requests and replies share a `cid`;
// unsolicited events have none.

/** Bump when a backward-incompatible change is made to the frame shapes. */
export const PROTOCOL_VERSION = 1

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
  | ProcessRequest
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
  | ProcessReply
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

export type DaemonEvent = DataEvent | ExitEvent | ProcessEvent

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
    case "process-output":
    case "process-exit":
      return typeof value.id === "string" ? (value as unknown as ProcessEvent) : null
    case "process-start-ok":
    case "process-attach-ok":
    case "process-list-ok":
    case "process-kill-ok":
    case "process-forget-ok":
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
