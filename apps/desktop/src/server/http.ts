import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { type Duplex, pipeline, Readable } from "node:stream"
import { applyWSSHandler } from "@trpc/server/adapters/ws"
import { type WebSocket, WebSocketServer } from "ws"
import type { AppContext } from "../main/trpc/context"
import { serverRouter } from "../main/trpc/serverRouter"
import { ConnectionFlow, type ConnectionFlowStats } from "../main/trpc/terminal/outputFlow"
import {
  DEVICE_REVOKE_PATH,
  IDENTITY_NONCE,
  IDENTITY_PATH,
  identityProof,
  TOKEN_HEADER,
} from "./access"
import { type DeviceAccess, LOCAL_DEVICE_ID } from "./devices"
import { DOWNLOAD_PATH, handleDownload, handleUpload, UPLOAD_PATH } from "./transfers"

export { TOKEN_HEADER }

/** Paths of the file streams that back Electron's custom URL schemes. */
export const SCHEME_PATH_PREFIX = "/scheme/"

export interface ListenOptions {
  port: number
  /** Device tokens: who may connect, and how to close a revoked device's sockets. */
  access: DeviceAccess
  /**
   * The local device token ("This Mac"). `GET /identity` proves the server
   * holds it; only the desktop app on this machine uses that check.
   */
  localToken: string
  createContext: () => AppContext
  /** Serve one custom-scheme request (`pi-lab-report://…`, `pi-lab-media://…`). */
  handleScheme: (scheme: string, request: Request) => Promise<Response>
  /**
   * Test mode only: serve `POST /test/drop-connections` (see {@link ListeningServer})
   * and `GET /test/connections` (see {@link ConnectionStats}).
   */
  testRoutes: boolean
}

export interface ListeningServer {
  port: number
  close: () => Promise<void>
  /** Close every client WebSocket from the server side, as a killed tunnel would. */
  dropConnections: () => void
}

/**
 * Provisional heartbeat (set after the flood test): the server pings a client
 * that sent nothing for this long, and closes it when no answer comes in time.
 * Clients ping on their own schedule too (renderer/trpc/serverLinks.ts).
 */
export const SERVER_PING_MS = 5_000
export const SERVER_PONG_WAIT_MS = 3_000

/**
 * Test mode only (`GET /test/connections`, for the flood test): per WebSocket,
 * the bytes queued now, the most seen queued when terminal output was checked
 * against the limit, when `behind` was sent (epoch ms), and the terminal
 * output flow control (cap, bytes in flight, skips, open streams). The last
 * 200 connections are kept, closed ones included.
 */
export interface ConnectionStats {
  id: number
  openedAt: number
  closedAt: number | null
  queuedBytes: number
  peakQueuedBytes: number
  behindAt: number[]
  output: ConnectionFlowStats
}

/** Stats kept per socket; the flow's numbers are read when asked. */
type ConnectionEntry = Omit<ConnectionStats, "output"> & { flow: ConnectionFlow }

const KEPT_CONNECTION_STATS = 200

/** The token a WebSocket upgrade presents in its `?token=` query. */
function queryToken(request: IncomingMessage): string | null {
  return new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("token")
}

/** Write a fetch Response to a Node response, streaming its body. */
async function sendResponse(response: Response, out: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    headers[name] = value
  })
  out.writeHead(response.status, headers)
  if (!response.body) {
    out.end()
    return
  }
  // A file that goes away mid-read ends this response only, never the server.
  pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    out,
    (error) => {
      if (error) console.warn(`[pi-lab server] stream ended early: ${error.message}`)
    },
  )
}

/**
 * `GET /scheme/<scheme>/<host>/<path>` serves what Electron's protocol handler
 * forwards; `GET /files/download` and `PUT /files/upload` move project files
 * for clients on other machines (transfers.ts). Everything needs the device token, except `GET /identity`, which
 * answers the HMAC of the client's nonce with the token, so a client can check
 * the port before it sends the token.
 */
async function handleHttp(
  options: ListenOptions,
  dropConnections: () => void,
  connectionStats: () => ConnectionStats[],
  request: IncomingMessage,
  out: ServerResponse,
): Promise<void> {
  const requested = new URL(request.url ?? "/", "http://127.0.0.1")
  const path = requested.pathname
  if (request.method === "GET" && path === IDENTITY_PATH) {
    const nonce = requested.searchParams.get("nonce") ?? ""
    if (!IDENTITY_NONCE.test(nonce)) {
      out.writeHead(400).end()
      return
    }
    // With `device=<id>`, the proof is keyed with that remote device's token hash.
    const deviceId = requested.searchParams.get("device")
    const key = deviceId === null ? options.localToken : options.access.proofKey(deviceId)
    if (key === null) {
      out.writeHead(404).end()
      return
    }
    out
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ proof: identityProof(key, nonce) }))
    return
  }
  const deviceId = options.access.authenticate(request.headers[TOKEN_HEADER]?.toString() ?? null)
  if (!deviceId) {
    out.writeHead(401).end()
    return
  }
  // A remote device revokes its own token (the client's "Remove machine").
  if (request.method === "POST" && path === DEVICE_REVOKE_PATH) {
    if (deviceId === LOCAL_DEVICE_ID) {
      out.writeHead(403).end()
      return
    }
    options.access.revoke(deviceId)
    out.writeHead(204).end()
    return
  }
  if (path === "/health") {
    out.writeHead(200, { "content-type": "text/plain" }).end("ok")
    return
  }
  if (options.testRoutes && request.method === "POST" && path === "/test/drop-connections") {
    out.writeHead(204).end()
    dropConnections()
    return
  }
  if (options.testRoutes && request.method === "GET" && path === "/test/connections") {
    out
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(connectionStats()))
    return
  }
  if (request.method === "GET" && path === DOWNLOAD_PATH) {
    await handleDownload(options.createContext(), requested, out)
    return
  }
  if (request.method === "PUT" && path === UPLOAD_PATH) {
    await handleUpload(options.createContext(), requested, request, out)
    return
  }
  if (!path.startsWith(SCHEME_PATH_PREFIX)) {
    out.writeHead(404).end()
    return
  }
  const rest = path.slice(SCHEME_PATH_PREFIX.length)
  const slash = rest.indexOf("/")
  if (slash < 1) {
    out.writeHead(404).end()
    return
  }
  const scheme = rest.slice(0, slash)
  const headers = new Headers()
  const range = request.headers.range
  if (range) headers.set("range", range)
  const response = await options.handleScheme(
    scheme,
    new Request(`${scheme}://${rest.slice(slash + 1)}`, { headers }),
  )
  await sendResponse(response, out)
}

/**
 * Listen on loopback only. tRPC runs over a WebSocket at `/trpc`; an upgrade
 * without the right token is refused with 401 before any call is accepted.
 */
export function listen(options: ListenOptions): Promise<ListeningServer> {
  const wss = new WebSocketServer({ noServer: true })
  const stats = new Map<WebSocket, ConnectionEntry>()
  let nextStatsId = 1
  /** Stats for this socket, recorded only with test routes on. */
  const statsFor = (ws: WebSocket, flow: ConnectionFlow): ConnectionEntry | null => {
    if (!options.testRoutes) return null
    let entry = stats.get(ws)
    if (!entry) {
      const opened: ConnectionEntry = {
        id: nextStatsId++,
        openedAt: Date.now(),
        closedAt: null,
        queuedBytes: 0,
        peakQueuedBytes: 0,
        behindAt: [],
        flow,
      }
      entry = opened
      stats.set(ws, opened)
      ws.once("close", () => {
        opened.closedAt = Date.now()
      })
      if (stats.size > KEPT_CONNECTION_STATS) stats.delete(stats.keys().next().value as WebSocket)
    }
    return entry
  }
  /** The device of each open socket, set at upgrade. */
  const devices = new WeakMap<WebSocket, string>()
  const handler = applyWSSHandler({
    wss,
    router: serverRouter,
    createContext: ({ res }) => {
      const deviceId = devices.get(res)
      if (!deviceId) throw new Error("WebSocket without an authenticated device")
      const outputFlow = new ConnectionFlow()
      const entry = statsFor(res, outputFlow)
      return {
        ...options.createContext(),
        connection: {
          deviceId,
          queuedBytes: () => {
            const queued = res.bufferedAmount
            if (entry) entry.peakQueuedBytes = Math.max(entry.peakQueuedBytes, queued)
            return queued
          },
          sentBehind: () => entry?.behindAt.push(Date.now()),
          outputFlow,
        },
      }
    },
    keepAlive: { enabled: true, pingMs: SERVER_PING_MS, pongWaitMs: SERVER_PONG_WAIT_MS },
  })
  const dropConnections = (): void => {
    for (const client of wss.clients) client.terminate()
  }
  const http: Server = createServer((request, response) => {
    const connectionStats = (): ConnectionStats[] =>
      [...stats.entries()].map(([ws, { flow, ...entry }]) => ({
        ...entry,
        queuedBytes: entry.closedAt === null ? ws.bufferedAmount : 0,
        output: flow.stats(),
      }))
    handleHttp(options, dropConnections, connectionStats, request, response).catch(
      (error: unknown) => {
        console.error("[pi-lab server] HTTP request failed:", error)
        if (!response.headersSent) response.writeHead(500)
        response.end()
      },
    )
  })
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname
    const deviceId = path === "/trpc" ? options.access.authenticate(queryToken(request)) : null
    if (!deviceId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      devices.set(ws, deviceId)
      // A revoked device loses its open sockets at once: the close frame
      // (1008: policy violation), then the socket ends, so no later message
      // from it is read.
      const forget = options.access.track(deviceId, () => {
        ws.close(1008, "Device token revoked")
        ws.terminate()
      })
      ws.once("close", forget)
      wss.emit("connection", ws, request)
    })
  }
  http.on("upgrade", (request, socket, head) => {
    // An unexpected error here would otherwise end the server process.
    Promise.resolve()
      .then(() => upgrade(request, socket, head))
      .catch((error: unknown) => {
        console.error("[pi-lab server] WebSocket upgrade failed:", error)
        if (!socket.destroyed) {
          socket.write("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n")
          socket.destroy()
        }
      })
  })
  return new Promise((resolve, reject) => {
    http.once("error", reject)
    http.listen(options.port, "127.0.0.1", () => {
      http.off("error", reject)
      resolve({
        port: (http.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            handler.broadcastReconnectNotification()
            for (const client of wss.clients) client.terminate()
            wss.close()
            http.close(() => done())
          }),
        dropConnections,
      })
    })
  })
}
