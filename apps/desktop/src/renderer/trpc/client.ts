import { createTRPCClient, splitLink, type TRPCLink } from "@trpc/client"
import type { AnyRouter } from "@trpc/server"
import { ipcLink } from "trpc-electron/renderer"
import type { DesktopRouter } from "../../main/desktop/desktopRouter"
import type { AppRouter } from "../../main/trpc/appRouter"
import { isDesktopPath } from "../../shared/desktopPaths"
import { connectionStatus } from "./connectionStatus"
import { createServerSockets, type ServerSockets } from "./serverLinks"

let lastIpcRequestId = 0

/** Give every IPC operation in this document a distinct ID. */
function uniqueIpcIds<TRouter extends AnyRouter>(): TRPCLink<TRouter> {
  return () =>
    ({ op, next }) => {
      if (lastIpcRequestId === Number.MAX_SAFE_INTEGER)
        throw new Error("IPC request IDs exhausted; reload PI Lab")
      lastIpcRequestId += 1
      return next({ ...op, id: lastIpcRequestId })
    }
}

/**
 * A client over Electron IPC only. Clients in one document share the request-ID
 * sequence, and the preload bridge scopes those IDs to the document.
 */
export function createIpcClient<TRouter extends AnyRouter>() {
  return createTRPCClient<TRouter>({
    links: [uniqueIpcIds<TRouter>(), ipcLink()],
  })
}

/** The Electron-only router, used here only to ask where the server listens. */
function desktopClient() {
  return createIpcClient<DesktopRouter>()
}

/**
 * The sockets to the PI Lab server, one pair per document, shared by every
 * client: calls and status on one, terminal output on the other.
 */
let serverSockets: ServerSockets<AppRouter> | null = null
function sharedServerSockets(): ServerSockets<AppRouter> {
  serverSockets ??= createServerSockets<AppRouter>({
    url: async () => (await desktopClient().desktop.serverEndpoint.query()).url,
    WebSocket: globalThis.WebSocket,
    status: connectionStatus,
  })
  return serverSockets
}

/**
 * Typed tRPC client. Calls the desktop app serves itself (native dialogs,
 * this device's notifications, Finder and clipboard; see
 * shared/desktopPaths.ts) go over Electron IPC; every other call goes over a
 * WebSocket to the PI Lab server (terminal output on a second socket). Both carry plain JSON (no transformer).
 * Components can inject fake clients.
 */
export function createPiLabTrpcClient() {
  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => isDesktopPath(op.path),
        true: [uniqueIpcIds<AppRouter>(), ipcLink()],
        false: sharedServerSockets().link,
      }),
    ],
  })
}

export type PiLabTrpcClient = ReturnType<typeof createPiLabTrpcClient>
