import { createTRPCClient, createWSClient, wsLink } from "@trpc/client"
import superjson from "superjson"
import { WebSocket } from "ws"
import type { ServerRouter } from "../trpc/serverRouter"
import type { ServerEndpoint } from "./launcher"

/** The WebSocket URL of a server endpoint, with the device token. */
export function serverSocketUrl(endpoint: ServerEndpoint): string {
  return `ws://127.0.0.1:${endpoint.port}/trpc?token=${encodeURIComponent(endpoint.token)}`
}

/**
 * The desktop app's own connection to the server, for what Electron main does
 * outside the renderer: tray data, Quit, notifications, quick edit, the
 * Electron-side halves of Finder and clipboard actions.
 */
export function createServerClient(endpoint: () => Promise<ServerEndpoint>) {
  const socket = createWSClient({
    // Read and checked on every connection attempt, so a restarted server's new
    // port is used and a process that took an old port never gets the token.
    url: async () => serverSocketUrl(await endpoint()),
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
  })
  const client = createTRPCClient<ServerRouter>({
    links: [wsLink({ client: socket, transformer: superjson })],
  })
  return { client, close: () => socket.close() }
}

export type ServerClient = ReturnType<typeof createServerClient>["client"]
