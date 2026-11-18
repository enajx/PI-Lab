import {
  createWSClient,
  splitLink,
  type TRPCLink,
  type TRPCWebSocketClient,
  type WebSocketLinkOptions,
  wsLink,
} from "@trpc/client"
import type { AnyRouter } from "@trpc/server"
import type { ConnectionStatus } from "./connectionStatus"

/**
 * Provisional heartbeat (set after the flood test): ping every 5 s, and treat
 * the link as dead when no pong comes within 3 s. The server pings too
 * (`server/http.ts`).
 */
export const CLIENT_KEEP_ALIVE = { enabled: true, intervalMs: 5_000, pongTimeoutMs: 3_000 }

/** Provisional reconnect backoff: at once, then 0.5 s, 1 s, 2 s, 4 s, capped at 5 s. */
export function reconnectDelayMs(attemptIndex: number): number {
  return attemptIndex === 0 ? 0 : Math.min(250 * 2 ** attemptIndex, 5_000)
}

/** The procedure whose subscriptions go over the terminal socket. */
export const TERMINAL_OUTPUT_PATH = "terminal.output"

export interface ServerSocketsOptions {
  /** The server endpoint with its token; read again on every connection attempt. */
  url: () => Promise<string>
  /** The WebSocket class: the browser's, or `ws` in Node. */
  WebSocket: typeof globalThis.WebSocket
  status: ConnectionStatus
}

export interface ServerSockets<TRouter extends AnyRouter> {
  /** Terminal output subscriptions go to the terminal socket, everything else to the calls socket. */
  link: TRPCLink<TRouter>
  /** Close both sockets (tests and the Expo stand-in). */
  close: () => Promise<void>
}

function socket(name: string, options: ServerSocketsOptions): TRPCWebSocketClient {
  options.status.socketCreated(name)
  return createWSClient({
    url: options.url,
    WebSocket: options.WebSocket,
    keepAlive: CLIENT_KEEP_ALIVE,
    retryDelayMs: reconnectDelayMs,
    onOpen: () => options.status.socketOpened(name),
    onClose: () => options.status.socketClosed(name),
  })
}

/**
 * Two tRPC WebSocket clients to one server, with the same endpoint and token:
 * one for calls and status, opened at once; one for terminal output, opened
 * when the first terminal subscribes and shared by every terminal after it.
 * tRPC reconnects each socket with {@link reconnectDelayMs}; terminals
 * resubscribe themselves (renderer/Terminal/terminalStream.ts).
 */
export function createServerSockets<TRouter extends AnyRouter>(
  options: ServerSocketsOptions,
): ServerSockets<TRouter> {
  const calls = socket("calls", options)
  let terminal: TRPCWebSocketClient | null = null
  // The server router has no transformer (plain JSON); a generic router type
  // cannot prove that, so the link options are asserted once here.
  const linkOptions = (client: TRPCWebSocketClient) => ({ client }) as WebSocketLinkOptions<TRouter>
  const callsLink = wsLink<TRouter>(linkOptions(calls))
  const terminalLink: TRPCLink<TRouter> = (runtime) => {
    let link: ReturnType<TRPCLink<TRouter>> | null = null
    return (op) => {
      if (link === null) {
        terminal ??= socket("terminal", options)
        link = wsLink<TRouter>(linkOptions(terminal))(runtime)
      }
      return link(op)
    }
  }
  return {
    link: splitLink<TRouter>({
      condition: (op) => op.type === "subscription" && op.path === TERMINAL_OUTPUT_PATH,
      true: terminalLink,
      false: callsLink,
    }),
    close: async () => {
      await calls.close()
      await terminal?.close()
    },
  }
}
