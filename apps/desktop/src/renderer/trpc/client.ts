import { createTRPCClient, splitLink, TRPCClientError, type TRPCLink } from "@trpc/client"
import type { AnyRouter } from "@trpc/server"
import { observable } from "@trpc/server/observable"
import { ipcLink } from "trpc-electron/renderer"
import type { DesktopRouter } from "../../main/desktop/desktopRouter"
import type { AppRouter } from "../../main/trpc/appRouter"
import { isDesktopPath } from "../../shared/desktopPaths"
import { type ConnectionStatus, connectionStatus } from "./connectionStatus"
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

/** The Electron-only router over IPC (server endpoints, remote machines). */
export function desktopIpc(): ReturnType<typeof createIpcClient<DesktopRouter>> {
  desktopClient ??= createIpcClient<DesktopRouter>()
  return desktopClient
}

/** The server's WebSocket URL now, asked again on every connection attempt. */
export async function serverSocketUrl(): Promise<string> {
  return (await desktopIpc().desktop.serverEndpoint.query()).url
}

/**
 * The sockets to a remote machine's server (see main/machines). Its URL goes
 * through the machine's SSH tunnel and is asked again on every connection
 * attempt; it fails while the machine cannot be reached, so the socket retries.
 */
export function createMachineSockets(
  machineId: string,
  status: ConnectionStatus,
): ServerSockets<AppRouter> {
  return createServerSockets<AppRouter>({
    url: async () => (await desktopIpc().desktop.machines.endpoint.query({ machineId })).url,
    WebSocket: globalThis.WebSocket,
    status,
  })
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
  return createTrpcClientOver(sharedServerSockets())
}

/**
 * Electron-side calls that act on this Mac's server and Finder (see
 * shared/desktopPaths.ts). For a project on another machine they would ask
 * the wrong server, so a machine's client refuses them with a clear error
 * (the views hide these actions there).
 */
const THIS_MAC_FILE_PATHS = [
  "files.reveal",
  "files.copyPath",
  "documents.openInBrowser",
  "notebooks.openInBrowser",
]

function refuseThisMacFilePaths(): TRPCLink<AppRouter> {
  return () =>
    ({ op, next }) => {
      if (!THIS_MAC_FILE_PATHS.includes(op.path)) return next(op)
      return observable((observer) => {
        observer.error(
          TRPCClientError.from(
            new Error(`${op.path} is not available for a project on another machine`),
          ),
        )
      })
    }
}

/** The tRPC client of a remote machine: its server calls go over that machine's `sockets`. */
export function createMachineTrpcClient(sockets: ServerSockets<AppRouter>) {
  return createTRPCClient<AppRouter>({
    links: [
      uniqueRequestIds<AppRouter>(),
      refuseThisMacFilePaths(),
      splitLink({
        condition: (op) => isDesktopPath(op.path),
        true: ipcLink(),
        false: sockets.link,
      }),
    ],
  })
}

/** A client like {@link createPiLabTrpcClient} whose server calls go over `sockets`. */
export function createTrpcClientOver(sockets: ServerSockets<AppRouter>) {
  return createTRPCClient<AppRouter>({
    links: [
      uniqueRequestIds<AppRouter>(),
      splitLink({
        condition: (op) => isDesktopPath(op.path),
        true: ipcLink(),
        false: sockets.link,
      }),
    ],
  })
}

export type PiLabTrpcClient = ReturnType<typeof createPiLabTrpcClient>
