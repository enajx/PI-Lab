import { createTRPCClient, createWSClient, splitLink, type TRPCLink, wsLink } from "@trpc/client"
import superjson from "superjson"
import { ipcLink } from "trpc-electron/renderer"
import type { DesktopRouter } from "../../main/desktop/desktopRouter"
import type { AppRouter } from "../../main/trpc/appRouter"
import { isDesktopPath } from "../../shared/desktopPaths"

let lastIpcRequestId = 0

/** Give every IPC operation in this document a distinct ID. */
function uniqueIpcIds<TRouter extends AppRouter | DesktopRouter>(): TRPCLink<TRouter> {
  return () =>
    ({ op, next }) => {
      if (lastIpcRequestId === Number.MAX_SAFE_INTEGER)
        throw new Error("IPC request IDs exhausted; reload PI Lab")
      lastIpcRequestId += 1
      return next({ ...op, id: lastIpcRequestId })
    }
}

/** The Electron-only router, used here only to ask where the server listens. */
const desktop = createTRPCClient<DesktopRouter>({
  links: [uniqueIpcIds<DesktopRouter>(), ipcLink({ transformer: superjson })],
})

/** One WebSocket to the PI Lab server per document, shared by every client. */
let serverSocket: ReturnType<typeof createWSClient> | null = null
function sharedServerSocket(): ReturnType<typeof createWSClient> {
  serverSocket ??= createWSClient({
    url: async () => (await desktop.desktop.serverEndpoint.query()).url,
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
      splitLink({
        condition: (op) => isDesktopPath(op.path),
        true: [uniqueIpcIds<AppRouter>(), ipcLink({ transformer: superjson })],
        false: wsLink({ client: sharedServerSocket(), transformer: superjson }),
      }),
    ],
  })
}

export type PiLabTrpcClient = ReturnType<typeof createPiLabTrpcClient>
