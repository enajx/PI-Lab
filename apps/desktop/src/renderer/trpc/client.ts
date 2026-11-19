import { createTRPCClient, splitLink, type TRPCLink } from "@trpc/client"
import type { AnyRouter } from "@trpc/server"
import { ipcLink } from "trpc-electron/renderer"
import type { DesktopRouter } from "../../main/desktop/desktopRouter"
import type { AppRouter } from "../../main/trpc/appRouter"
import { isDesktopPath } from "../../shared/desktopPaths"
import { connectionStatus } from "./connectionStatus"
import { createServerSockets, type ServerSockets } from "./serverLinks"

let lastRequestId = 0

/**
 * Give every operation in this document a distinct ID, over IPC and over the
 * shared server socket. Each tRPC client counts from 1, and the socket and the
 * preload match replies by ID, so clients in one document share this sequence.
 */
function uniqueRequestIds<TRouter extends AnyRouter>(): TRPCLink<TRouter> {
  return () =>
    ({ op, next }) => {
      if (lastRequestId === Number.MAX_SAFE_INTEGER)
        throw new Error("Request IDs exhausted; reload PI Lab")
      lastRequestId += 1
      return next({ ...op, id: lastRequestId })
    }
}

/**
 * A client over Electron IPC only. Clients in one document share the request-ID
 * sequence, and the preload bridge scopes those IDs to the document.
 */
export function createIpcClient<TRouter extends AnyRouter>() {
  return createTRPCClient<TRouter>({
    links: [uniqueRequestIds<TRouter>(), ipcLink()],
  })
}

/**
 * The Electron-only router, used here only to ask where the server listens.
 * Created once per document: each IPC client adds a preload listener.
 */
let desktopClient: ReturnType<typeof createIpcClient<DesktopRouter>> | null = null

/** The server's WebSocket URL now, asked again on every connection attempt. */
export async function serverSocketUrl(): Promise<string> {
  desktopClient ??= createIpcClient<DesktopRouter>()
  return (await desktopClient.desktop.serverEndpoint.query()).url
}

/**
 * The sockets to the PI Lab server, one pair per document, shared by every
 * client: calls and status on one, terminal output on the other. Both ask
 * for the identity-checked URL on every connection attempt.
 */
let serverSockets: ServerSockets<AppRouter> | null = null
function sharedServerSockets(): ServerSockets<AppRouter> {
  serverSockets ??= createServerSockets<AppRouter>({
    url: serverSocketUrl,
    WebSocket: globalThis.WebSocket,
    status: connectionStatus,
  })
  return serverSockets
}

/**
 * Typed tRPC client. Calls the desktop app serves itself (native dialogs,
 * this device's notifications, Finder and clipboard; see
 * shared/desktopPaths.ts) go over Electron IPC; every other call goes over a
 * WebSocket to the PI Lab server (terminal output on a second socket). Both
 * carry plain JSON (no transformer).
 * Components can inject fake clients.
 */
export function createPiLabTrpcClient() {
  return createTRPCClient<AppRouter>({
    links: [
      uniqueRequestIds<AppRouter>(),
      splitLink({
        condition: (op) => isDesktopPath(op.path),
        true: ipcLink(),
        false: sharedServerSockets().link,
      }),
    ],
  })
}

export type PiLabTrpcClient = ReturnType<typeof createPiLabTrpcClient>
