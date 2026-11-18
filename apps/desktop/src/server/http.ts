import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { pipeline, Readable } from "node:stream"
import { applyWSSHandler } from "@trpc/server/adapters/ws"
import { WebSocketServer } from "ws"
import type { AppContext } from "../main/trpc/context"
import { serverRouter } from "../main/trpc/serverRouter"
import { IDENTITY_NONCE, IDENTITY_PATH, identityProof, TOKEN_HEADER } from "./access"
import type { DeviceAccess } from "./devices"

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
  /** Test mode only: serve `POST /test/drop-connections` (see {@link ListeningServer}). */
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
 * forwards. Everything needs the device token, except `GET /identity`, which
 * answers the HMAC of the client's nonce with the token, so a client can check
 * the port before it sends the token.
 */
async function handleHttp(
  options: ListenOptions,
  dropConnections: () => void,
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
    out
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ proof: identityProof(options.localToken, nonce) }))
    return
  }
  if (!options.access.authenticate(request.headers[TOKEN_HEADER]?.toString() ?? null)) {
    out.writeHead(401).end()
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
  const handler = applyWSSHandler({
    wss,
    router: serverRouter,
    createContext: ({ res }) => ({
      ...options.createContext(),
      connection: { queuedBytes: () => res.bufferedAmount },
    }),
    keepAlive: { enabled: true, pingMs: SERVER_PING_MS, pongWaitMs: SERVER_PONG_WAIT_MS },
  })
  const dropConnections = (): void => {
    for (const client of wss.clients) client.terminate()
  }
  const http: Server = createServer((request, response) => {
    handleHttp(options, dropConnections, request, response).catch((error: unknown) => {
      console.error("[pi-lab server] HTTP request failed:", error)
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  http.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname
    const deviceId = path === "/trpc" ? options.access.authenticate(queryToken(request)) : null
    if (!deviceId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      // A revoked device loses its open sockets at once (1008: policy violation).
      const forget = options.access.track(deviceId, () => ws.close(1008, "Device token revoked"))
      ws.once("close", forget)
      wss.emit("connection", ws, request)
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
