import { createTRPCClient, createWSClient, splitLink, type TRPCLink, wsLink } from "@trpc/client"
import type { AnyRouter } from "@trpc/server"
import superjson from "superjson"
import { ipcLink } from "trpc-electron/renderer"
import type { DesktopRouter } from "../../main/desktop/desktopRouter"
import type { AppRouter } from "../../main/trpc/appRouter"
import { isDesktopPath } from "../../shared/desktopPaths"

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
    links: [uniqueRequestIds<TRouter>(), ipcLink({ transformer: superjson })],
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

/** One WebSocket to the PI Lab server per document, shared by every client. */
let serverSocket: ReturnType<typeof createWSClient> | null = null
function sharedServerSocket(): ReturnType<typeof createWSClient> {
  serverSocket ??= createWSClient({
    url: serverSocketUrl,
  })
  return serverSocket
}

/**
 * Typed tRPC client. Calls the desktop app serves itself (native dialogs,
 * this device's notifications, Finder and clipboard; see
 * shared/desktopPaths.ts) go over Electron IPC; every other call goes over a
 * WebSocket to the PI Lab server. SuperJSON must match both routers.
 * Components can inject fake clients.
 */
export function createPiLabTrpcClient() {
  return createTRPCClient<AppRouter>({
    links: [
      uniqueRequestIds<AppRouter>(),
      splitLink({
        condition: (op) => isDesktopPath(op.path),
        true: ipcLink({ transformer: superjson }),
        false: wsLink({ client: sharedServerSocket(), transformer: superjson }),
      }),
    ],
  })
}

export type PiLabTrpcClient = ReturnType<typeof createPiLabTrpcClient>
