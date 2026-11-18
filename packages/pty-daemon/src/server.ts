// Sessions survive socket disconnection; only event subscriptions end.

import { existsSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { createServer, type Server as NetServer, type Socket } from "node:net"
import { type ProcessJob, ProcessJobStore, UnknownProcessError } from "./processJobs"
import {
  type ClientRequest,
  type DaemonFrame,
  type DaemonReply,
  encodeFrame,
  FrameDecoder,
  PROTOCOL_VERSION,
  parseClientRequest,
} from "./protocol"
import { type SessionHandle, SessionStore, type SessionStoreOptions } from "./session"

// Bounds stalled readers of live output; attach replies use the replay limit.
// A connection over it is dropped (logged, with a `closing` frame giving the
// reason); the server reconnects and resumes each terminal from its offset.
const MAX_PENDING_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_PROCESS_REPLAY_BYTES = 16 * 1024 * 1024
// A dropped connection whose reader takes longer than this to take what is
// queued is destroyed, so a reader that stopped for good cannot hold the queue.
const DROPPED_FLUSH_MS = 10_000

export interface DaemonServerOptions {
  /** Absolute path of the Unix socket to listen on. */
  socketPath: string
  store?: SessionStoreOptions
  /** Called after a client's shutdown request has closed the server (the entry exits here). */
  afterShutdownRequest?: () => void
}

/** Per-connection state: the socket, its decoder, and its active subscriptions. */
class Connection {
  private readonly decoder = new FrameDecoder()
  /** sessionId -> unsubscribe fn for every session this connection is attached to. */
  private readonly subscriptions = new Map<string, () => void>()
  /** Set once the connection is dropped: nothing more is sent on it. */
  private dropped = false

  constructor(
    readonly socket: Socket,
    private readonly onRequest: (request: ClientRequest, connection: Connection) => void,
  ) {
    socket.setEncoding("utf8")
    socket.on("data", (raw: string) => this.ingest(raw))
  }

  private ingest(raw: string): void {
    let decoded: unknown[]
    try {
      decoded = this.decoder.push(raw)
    } catch (error) {
      // A line that is not valid JSON is unrecoverable for the stream position,
      // so close the connection rather than risk desyncing the framing.
      this.drop(`a request line was not valid JSON (${errorMessage(error)})`)
      return
    }
    for (const value of decoded) {
      const request = parseClientRequest(value)
      if (request) this.onRequest(request, this)
    }
  }

  send(frame: DaemonFrame): void {
    if (this.socket.destroyed || this.dropped) return
    const encoded = encodeFrame(frame)
    const limit =
      frame.kind === "attach-ok" ||
      frame.kind === "process-attach-ok" ||
      frame.kind === "process-start-ok" ||
      frame.kind === "process-exit"
        ? MAX_PROCESS_REPLAY_BYTES
        : MAX_PENDING_OUTPUT_BYTES
    if (this.socket.writableLength + Buffer.byteLength(encoded) > limit) {
      // The session keeps running and its bounded replay remains available on reattach.
      this.drop(
        `pending output over ${limit} bytes (${this.socket.writableLength} queued, the reader is too slow)`,
      )
      return
    }
    this.socket.write(encoded)
  }

  /**
   * Stop sending on this connection, log why, and close it after what is
   * already queued, ending with a `closing` frame that tells the client why.
   */
  private drop(reason: string): void {
    if (this.dropped) return
    this.dropped = true
    console.warn(`[pty-daemon] dropped a client connection: ${reason}`)
    this.dispose()
    this.socket.end(encodeFrame({ kind: "closing", reason }))
    const socket = this.socket
    setTimeout(() => {
      if (socket.destroyed) return
      console.warn(
        `[pty-daemon] destroyed a dropped client connection: its reader did not take the queued output within ${DROPPED_FLUSH_MS}ms`,
      )
      socket.destroy()
    }, DROPPED_FLUSH_MS).unref()
  }

  attach(session: SessionHandle): void {
    // Renew an existing attachment so a repeated attach also sees a cached exit.
    this.detach(session.id)
    const sessionId = session.id
    const generation = session.generation
    const unsubscribe = session.subscribe({
      onData: (bytes, offset) =>
        this.send({
          kind: "data",
          sessionId,
          generation,
          offset,
          base64: bytes.toString("base64"),
        }),
      onResize: (cols, rows, revision, offset) =>
        this.send({ kind: "resize", sessionId, generation, offset, revision, cols, rows }),
      onEcho: (echo, offset) => this.send({ kind: "echo", sessionId, generation, offset, echo }),
      onEchoAck: (key, offset, echo) =>
        this.send({
          kind: "echo-ack",
          sessionId,
          generation,
          clientId: key.clientId,
          seq: key.seq,
          offset,
          echo,
        }),
      onExit: (exitCode, signal) =>
        this.send({ kind: "exit", sessionId: session.id, exitCode, signal }),
    })
    this.subscriptions.set(session.id, unsubscribe)
  }

  attachProcess(job: ProcessJob): void {
    const key = `process:${job.id}`
    this.detach(key)
    this.subscriptions.set(
      key,
      job.subscribe((event) => this.send(event)),
    )
  }

  detach(sessionId: string): void {
    const unsubscribe = this.subscriptions.get(sessionId)
    if (unsubscribe) {
      unsubscribe()
      this.subscriptions.delete(sessionId)
    }
  }

  dispose(): void {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe()
    this.subscriptions.clear()
  }
}

export class DaemonServer {
  private readonly server: NetServer
  private readonly jobs = new ProcessJobStore()
  private readonly store: SessionStore
  private readonly connections = new Set<Connection>()
  private readonly socketPath: string
  private readonly afterShutdownRequest: (() => void) | undefined
  private closing: Promise<void> | null = null

  constructor(options: DaemonServerOptions) {
    this.socketPath = options.socketPath
    this.afterShutdownRequest = options.afterShutdownRequest
    const onSessionReaped = options.store?.onSessionReaped
    this.store = new SessionStore({
      ...options.store,
      onSessionReaped: (sessionId) => {
        for (const connection of this.connections) connection.detach(sessionId)
        onSessionReaped?.(sessionId)
      },
    })
    this.server = createServer((socket) => this.handleConnection(socket))
  }

  /** Bind the socket. Removes a stale socket file left by a prior crashed daemon. */
  async listen(): Promise<void> {
    if (existsSync(this.socketPath)) {
      await unlink(this.socketPath).catch(() => {})
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      this.server.once("error", onError)
      this.server.listen(this.socketPath, () => {
        this.server.removeListener("error", onError)
        resolve()
      })
    })
  }

  private handleConnection(socket: Socket): void {
    const connection = new Connection(socket, (request, conn) => this.route(request, conn))
    this.connections.add(connection)
    const cleanup = () => {
      connection.dispose()
      this.connections.delete(connection)
    }
    socket.on("close", cleanup)
    socket.on("error", (error) => {
      console.warn(`[pty-daemon] client connection error: ${errorMessage(error)}`)
      cleanup()
    })
  }

  private route(request: ClientRequest, connection: Connection): void {
    switch (request.kind) {
      case "process-start":
      case "process-attach":
      case "process-list":
      case "process-kill":
      case "process-forget":
        void this.handleProcess(request, connection).catch((error: unknown) =>
          this.fail(
            connection,
            request.cid,
            error instanceof UnknownProcessError ? "unknown-process" : "process-failed",
            errorMessage(error),
          ),
        )
        break
      case "spawn":
        this.handleSpawn(request, connection)
        break
      case "attach":
        this.handleAttach(request, connection)
        break
      case "detach":
        this.handleDetach(request, connection)
        break
      case "write":
        this.handleWrite(request, connection)
        break
      case "resize":
        this.handleResize(request, connection)
        break
      case "kill":
        this.handleKill(request, connection)
        break
      case "list":
        this.handleList(request, connection)
        break
      case "shutdown":
        this.handleShutdown(request, connection)
        break
    }
  }

  private async handleProcess(
    request: Extract<ClientRequest, { kind: `process-${string}` }>,
    connection: Connection,
  ): Promise<void> {
    switch (request.kind) {
      case "process-start": {
        const job = await this.jobs.start(request)
        const snapshot = job.info()
        this.reply(connection, { kind: "process-start-ok", cid: request.cid, process: snapshot })
        connection.attachProcess(job)
        break
      }
      case "process-list":
        this.reply(connection, {
          kind: "process-list-ok",
          cid: request.cid,
          processes: this.jobs.list(),
        })
        break
      case "process-attach": {
        const job = this.jobs.get(request.id)
        const snapshot = job.info()
        this.reply(connection, { kind: "process-attach-ok", cid: request.cid, process: snapshot })
        connection.attachProcess(job)
        break
      }
      case "process-kill": {
        const job = this.jobs.get(request.id)
        job.kill()
        await job.closed
        this.reply(connection, { kind: "process-kill-ok", cid: request.cid })
        break
      }
      case "process-forget":
        this.jobs.forget(request.id)
        for (const attached of this.connections) attached.detach(`process:${request.id}`)
        this.reply(connection, { kind: "process-forget-ok", cid: request.cid })
        break
    }
  }

  private reply(connection: Connection, frame: DaemonReply): void {
    connection.send(frame)
  }

  private fail(connection: Connection, cid: string, code: string, message: string): void {
    this.reply(connection, { kind: "error", cid, code, message })
  }

  private handleSpawn(
    request: Extract<ClientRequest, { kind: "spawn" }>,
    connection: Connection,
  ): void {
    let session: SessionHandle
    try {
      session = this.store.spawn({
        command: request.command,
        args: request.args,
        cwd: request.cwd,
        env: request.env,
        cols: request.cols,
        rows: request.rows,
      })
    } catch (error) {
      this.fail(connection, request.cid, "spawn-failed", errorMessage(error))
      return
    }
    // The spawning connection is attached implicitly so it begins streaming
    // output from offset 0 without a separate round-trip.
    connection.attach(session)
    this.reply(connection, {
      kind: "spawn-ok",
      cid: request.cid,
      session: session.info(),
      generation: session.generation,
    })
  }

  private handleAttach(
    request: Extract<ClientRequest, { kind: "attach" }>,
    connection: Connection,
  ): void {
    const session = this.store.get(request.sessionId)
    if (!session) {
      this.fail(connection, request.cid, "unknown-session", `no session ${request.sessionId}`)
      return
    }
    // The start and the subscription happen in one synchronous step, so live
    // events continue at the start's end offset with no gap or overlap.
    const start = session.startFrom(request.resume)
    const info = session.info()
    const base64 = start.bytes.toString("base64")
    this.reply(connection, {
      kind: "attach-ok",
      cid: request.cid,
      session: info,
      generation: session.generation,
      revision: session.screenRevision,
      echo: session.echo,
      cols: info.cols,
      rows: info.rows,
      start:
        start.mode === "replay"
          ? { mode: "replay", offset: start.offset, base64 }
          : start.mode === "snapshot"
            ? { mode: "snapshot", offset: start.offset, screen: start.screen, base64 }
            : {
                mode: "refresh",
                base: start.base,
                offset: start.offset,
                screen: start.screen,
                base64,
              },
    })
    connection.attach(session)
  }

  private handleDetach(
    request: Extract<ClientRequest, { kind: "detach" }>,
    connection: Connection,
  ): void {
    connection.detach(request.sessionId)
    this.reply(connection, { kind: "detach-ok", cid: request.cid, sessionId: request.sessionId })
  }

  private handleWrite(
    request: Extract<ClientRequest, { kind: "write" }>,
    connection: Connection,
  ): void {
    const session = this.store.get(request.sessionId)
    if (!session) {
      this.fail(connection, request.cid, "unknown-session", `no session ${request.sessionId}`)
      return
    }
    if (request.message === true) session.writeMessage(request.data)
    else session.write(request.data, request.key ?? null)
    this.reply(connection, { kind: "write-ok", cid: request.cid, sessionId: request.sessionId })
  }

  private handleResize(
    request: Extract<ClientRequest, { kind: "resize" }>,
    connection: Connection,
  ): void {
    const session = this.store.get(request.sessionId)
    if (!session) {
      this.fail(connection, request.cid, "unknown-session", `no session ${request.sessionId}`)
      return
    }
    session.resize(request.cols, request.rows)
    this.reply(connection, {
      kind: "resize-ok",
      cid: request.cid,
      sessionId: request.sessionId,
      cols: request.cols,
      rows: request.rows,
    })
  }

  private handleKill(
    request: Extract<ClientRequest, { kind: "kill" }>,
    connection: Connection,
  ): void {
    const session = this.store.get(request.sessionId)
    if (!session) {
      this.fail(connection, request.cid, "unknown-session", `no session ${request.sessionId}`)
      return
    }
    session.kill(request.signal)
    this.reply(connection, { kind: "kill-ok", cid: request.cid, sessionId: request.sessionId })
  }

  private handleList(
    request: Extract<ClientRequest, { kind: "list" }>,
    connection: Connection,
  ): void {
    this.reply(connection, {
      kind: "list-ok",
      cid: request.cid,
      sessions: this.store.list(),
      protocol: PROTOCOL_VERSION,
    })
  }

  /** Confirm first, then close once the reply is flushed, since closing destroys the socket. */
  private handleShutdown(
    request: Extract<ClientRequest, { kind: "shutdown" }>,
    connection: Connection,
  ): void {
    const reply = encodeFrame({ kind: "shutdown-ok", cid: request.cid, pid: process.pid })
    connection.socket.write(reply, () => {
      void this.close().then(() => this.afterShutdownRequest?.())
    })
  }

  /** Kill every session, close all connections, stop listening, remove the socket file. Idempotent. */
  close(): Promise<void> {
    this.closing ??= this.closeOnce()
    return this.closing
  }

  private async closeOnce(): Promise<void> {
    await this.jobs.close()
    for (const connection of this.connections) {
      connection.dispose()
      connection.socket.destroy()
    }
    this.connections.clear()
    this.store.shutdown()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    if (existsSync(this.socketPath)) {
      await unlink(this.socketPath).catch(() => {})
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve the socket path from an explicit value, then `PI_LAB_SOCKET_PATH`. */
export function resolveSocketPath(explicit?: string): string {
  const path = explicit ?? process.env.PI_LAB_SOCKET_PATH
  if (!path) {
    throw new Error("no socket path: pass one explicitly or set PI_LAB_SOCKET_PATH")
  }
  return path
}
