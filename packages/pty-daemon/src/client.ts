// Match daemon replies by `cid`; deliver session events to subscribers.

import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { connect, type Socket } from "node:net"
import {
  type ClientRequest,
  type DaemonFrame,
  type DaemonReply,
  type DataEvent,
  type ErrorReply,
  type ExitEvent,
  encodeFrame,
  FrameDecoder,
  type ProcessExitEvent,
  type ProcessOutputEvent,
  type ProcessParams,
  type ProcessReply,
  type ProcessSnapshot,
  type ProcessSummary,
  parseDaemonFrame,
  type SessionInfo,
} from "./protocol"

/** Raised when the daemon answers a request with an `error` reply. */
export class DaemonError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "DaemonError"
  }
}

interface PendingRequest {
  resolve: (reply: Exclude<DaemonReply, ErrorReply>) => void
  reject: (error: Error) => void
  receive?: (reply: Exclude<DaemonReply, ErrorReply>) => void
}

export interface SpawnParams {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
}

export interface AttachResult {
  session: SessionInfo
  scrollback: string
}

/** Listener signatures for the client's session-scoped events. */
export interface DaemonClientEvents {
  "process-output": (event: ProcessOutputEvent) => void
  "process-exit": (event: ProcessExitEvent) => void
  data: (event: DataEvent) => void
  exit: (event: ExitEvent) => void
  /** Emitted when the underlying socket closes. */
  close: () => void
}

export class DaemonClient extends EventEmitter {
  private socket: Socket | null = null
  private readonly decoder = new FrameDecoder()
  private readonly pending = new Map<string, PendingRequest>()

  constructor(private readonly socketPath: string) {
    super()
  }

  /** Open the connection. Resolves once the socket is connected. */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = connect(this.socketPath)
      socket.setEncoding("utf8")
      const onConnect = () => {
        socket.removeListener("error", onError)
        this.socket = socket
        // Transport failures settle through close, including pending RPCs and session observers.
        socket.on("error", () => socket.destroy())
        socket.on("data", (raw: string) => this.ingest(raw))
        socket.on("close", () => this.handleClose())
        resolve()
      }
      const onError = (error: Error) => {
        socket.removeListener("connect", onConnect)
        reject(error)
      }
      socket.once("connect", onConnect)
      socket.once("error", onError)
    })
  }

  private ingest(raw: string): void {
    let decoded: unknown[]
    try {
      decoded = this.decoder.push(raw)
    } catch {
      return
    }
    for (const value of decoded) {
      const frame = parseDaemonFrame(value)
      if (frame) this.dispatch(frame)
    }
  }

  private dispatch(frame: DaemonFrame): void {
    if (frame.kind === "process-output" || frame.kind === "process-exit") {
      this.emit(frame.kind, frame)
      return
    }
    if (frame.kind === "data" || frame.kind === "exit") {
      this.emit(frame.kind, frame)
      this.emit(`session:${frame.sessionId}`, frame)
      return
    }
    const pending = this.pending.get(frame.cid)
    if (!pending) return
    this.pending.delete(frame.cid)
    if (frame.kind === "error") {
      pending.reject(new DaemonError(frame.code, frame.message))
    } else {
      pending.receive?.(frame)
      pending.resolve(frame)
    }
  }

  private handleClose(): void {
    const closeError = new Error("daemon connection closed")
    for (const pending of this.pending.values()) pending.reject(closeError)
    this.pending.clear()
    this.socket = null
    this.emit("close")
  }

  private request<R extends Exclude<DaemonReply, ErrorReply>>(
    build: (cid: string) => ClientRequest,
    receive?: (reply: R) => void,
  ): Promise<R> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error("client is not connected"))
    const cid = randomUUID()
    return new Promise<R>((resolve, reject) => {
      this.pending.set(cid, {
        resolve: resolve as PendingRequest["resolve"],
        reject,
        receive: receive as PendingRequest["receive"],
      })
      socket.write(encodeFrame(build(cid)))
    })
  }

  /** A bounded RPC wait also rejects explicitly when an old daemon ignores job requests. */
  private processRequest<R extends ProcessReply>(
    build: (cid: string) => ClientRequest,
    receive: ((reply: R) => void) | undefined,
  ): Promise<R> {
    let timer: ReturnType<typeof setTimeout>
    let requestId: string | undefined
    const response = this.request<R>((cid) => {
      requestId = cid
      return build(cid)
    }, receive)
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (requestId) this.pending.delete(requestId)
        reject(new Error("Daemon process request timed out; the running daemon may need an update"))
      }, 5000)
      timer.unref()
    })
    return Promise.race([response, timeout]).finally(() => clearTimeout(timer))
  }

  async startProcess(params: ProcessParams): Promise<ProcessSnapshot> {
    const reply = await this.processRequest<Extract<ProcessReply, { process: ProcessSnapshot }>>(
      (cid) => ({ kind: "process-start", cid, ...params }),
      undefined,
    )
    return reply.process
  }

  async listProcesses(): Promise<ProcessSummary[]> {
    const reply = await this.processRequest<Extract<ProcessReply, { kind: "process-list-ok" }>>(
      (cid) => ({ kind: "process-list", cid }),
      undefined,
    )
    return reply.processes
  }

  async attachProcess(
    id: string,
    onReplay?: (snapshot: ProcessSnapshot) => void,
  ): Promise<ProcessSnapshot> {
    const reply = await this.processRequest<Extract<ProcessReply, { process: ProcessSnapshot }>>(
      (cid) => ({ kind: "process-attach", cid, id }),
      (frame) => onReplay?.(frame.process),
    )
    return reply.process
  }

  async killProcess(id: string): Promise<void> {
    await this.processRequest((cid) => ({ kind: "process-kill", cid, id }), undefined)
  }

  async forgetProcess(id: string): Promise<void> {
    await this.processRequest((cid) => ({ kind: "process-forget", cid, id }), undefined)
  }

  async spawn(params: SpawnParams): Promise<SessionInfo> {
    const reply = await this.request<Extract<DaemonReply, { kind: "spawn-ok" }>>((cid) => ({
      kind: "spawn",
      cid,
      command: params.command,
      args: params.args,
      cwd: params.cwd,
      env: params.env,
      cols: params.cols,
      rows: params.rows,
    }))
    return reply.session
  }

  /** Deliver replay synchronously at the reply boundary, before later frames in the same read. */
  async attach(
    sessionId: string,
    onReplay?: (result: AttachResult) => void,
  ): Promise<AttachResult> {
    const reply = await this.request<Extract<DaemonReply, { kind: "attach-ok" }>>(
      (cid) => ({
        kind: "attach",
        cid,
        sessionId,
      }),
      (frame) => onReplay?.({ session: frame.session, scrollback: frame.scrollback }),
    )
    return { session: reply.session, scrollback: reply.scrollback }
  }

  async detach(sessionId: string): Promise<void> {
    await this.request<Extract<DaemonReply, { kind: "detach-ok" }>>((cid) => ({
      kind: "detach",
      cid,
      sessionId,
    }))
  }

  async write(sessionId: string, data: string): Promise<void> {
    await this.request<Extract<DaemonReply, { kind: "write-ok" }>>((cid) => ({
      kind: "write",
      cid,
      sessionId,
      data,
    }))
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.request<Extract<DaemonReply, { kind: "resize-ok" }>>((cid) => ({
      kind: "resize",
      cid,
      sessionId,
      cols,
      rows,
    }))
  }

  async kill(sessionId: string, signal?: string): Promise<void> {
    await this.request<Extract<DaemonReply, { kind: "kill-ok" }>>((cid) => ({
      kind: "kill",
      cid,
      sessionId,
      signal,
    }))
  }

  async list(): Promise<SessionInfo[]> {
    const reply = await this.request<Extract<DaemonReply, { kind: "list-ok" }>>((cid) => ({
      kind: "list",
      cid,
    }))
    return reply.sessions
  }

  /**
   * Ask the daemon to stop every session and job and exit. Resolves with the
   * daemon's pid once it confirms; a daemon built before this request ignores
   * it, so callers bound the wait.
   */
  async shutdown(): Promise<{ pid: number }> {
    const reply = await this.request<Extract<DaemonReply, { kind: "shutdown-ok" }>>((cid) => ({
      kind: "shutdown",
      cid,
    }))
    return { pid: reply.pid }
  }

  /**
   * Async iterator over a single session's events. Yields `data` events and a
   * final `exit` event, after which it completes. Convenient for tests and for
   * draining a session to completion.
   */
  events(sessionId: string): AsyncIterableIterator<DataEvent | ExitEvent> {
    const queue: (DataEvent | ExitEvent)[] = []
    let resolveNext: ((result: IteratorResult<DataEvent | ExitEvent>) => void) | null = null
    let done = false

    const onEvent = (event: DataEvent | ExitEvent) => {
      if (resolveNext) {
        resolveNext({ value: event, done: false })
        resolveNext = null
      } else {
        queue.push(event)
      }
      if (event.kind === "exit") finish()
    }

    const finish = () => {
      done = true
      this.off(`session:${sessionId}`, onEvent)
      if (resolveNext) {
        resolveNext({ value: undefined, done: true })
        resolveNext = null
      }
    }

    this.on(`session:${sessionId}`, onEvent)

    const iterator: AsyncIterableIterator<DataEvent | ExitEvent> = {
      next(): Promise<IteratorResult<DataEvent | ExitEvent>> {
        const queued = queue.shift()
        if (queued) return Promise.resolve({ value: queued, done: false })
        if (done) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          resolveNext = resolve
        })
      },
      return(): Promise<IteratorResult<DataEvent | ExitEvent>> {
        finish()
        return Promise.resolve({ value: undefined, done: true })
      },
      [Symbol.asyncIterator]() {
        return iterator
      },
    }
    return iterator
  }

  /** Close the socket. Pending requests reject. */
  close(): void {
    this.socket?.end()
    this.socket?.destroy()
    this.socket = null
  }

  // Narrow the inherited emitter typings for the events we actually emit.
  override on<E extends keyof DaemonClientEvents>(event: E, listener: DaemonClientEvents[E]): this
  override on(event: string, listener: (...args: never[]) => void): this
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }
}
