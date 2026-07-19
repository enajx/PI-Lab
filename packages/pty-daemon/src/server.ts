// The daemon: a Unix-domain socket server that owns a SessionStore and routes
// the wire protocol. One server can serve many concurrent client connections;
// each connection tracks which sessions it is attached to and forwards their
// live events. Sessions outlive connections (that is the whole point of the
// daemon), so disconnecting only tears down subscriptions, not PTYs.

import { existsSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { createServer, type Server as NetServer, type Socket } from "node:net"
import {
  type ClientRequest,
  type DaemonFrame,
  type DaemonReply,
  encodeFrame,
  FrameDecoder,
  parseClientRequest,
} from "./protocol"
import { type SessionHandle, SessionStore, type SessionStoreOptions } from "./session"

export interface DaemonServerOptions {
  /** Absolute path of the Unix socket to listen on. */
  socketPath: string
  store?: SessionStoreOptions
}

/** Per-connection state: the socket, its decoder, and its active subscriptions. */
class Connection {
  private readonly decoder = new FrameDecoder()
  /** sessionId -> unsubscribe fn for every session this connection is attached to. */
  private readonly subscriptions = new Map<string, () => void>()

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
    } catch {
      // A line that is not valid JSON is unrecoverable for the stream position,
      // so close the connection rather than risk desyncing the framing.
      this.socket.destroy()
      return
    }
    for (const value of decoded) {
      const request = parseClientRequest(value)
      if (request) this.onRequest(request, this)
    }
  }

  send(frame: DaemonFrame): void {
    if (!this.socket.destroyed) this.socket.write(encodeFrame(frame))
  }

  attach(session: SessionHandle): void {
    if (this.subscriptions.has(session.id)) return
    const unsubscribe = session.subscribe({
      onData: (chunk) => this.send({ kind: "data", sessionId: session.id, chunk }),
      onExit: (exitCode, signal) =>
        this.send({ kind: "exit", sessionId: session.id, exitCode, signal }),
    })
    this.subscriptions.set(session.id, unsubscribe)
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
  private readonly store: SessionStore
  private readonly connections = new Set<Connection>()
  private readonly socketPath: string

  constructor(options: DaemonServerOptions) {
    this.socketPath = options.socketPath
    this.store = new SessionStore(options.store)
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
    socket.on("error", cleanup)
  }

  private route(request: ClientRequest, connection: Connection): void {
    switch (request.kind) {
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
    // output without a separate round-trip. Scrollback is empty at spawn time.
    connection.attach(session)
    this.reply(connection, { kind: "spawn-ok", cid: request.cid, session: session.info() })
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
    // Snapshot scrollback before subscribing so the replay and the live stream
    // do not overlap or drop a chunk that arrives between the two steps.
    const scrollback = session.getScrollback()
    const info = session.info()
    connection.attach(session)
    this.reply(connection, { kind: "attach-ok", cid: request.cid, session: info, scrollback })
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
    session.write(request.data)
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
    this.reply(connection, { kind: "list-ok", cid: request.cid, sessions: this.store.list() })
  }

  /** Kill every session, close all connections, stop listening, remove the socket file. */
  async close(): Promise<void> {
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
