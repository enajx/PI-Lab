import { createTRPCClient, type TRPCLink } from "@trpc/client"
import superjson from "superjson"
import { ipcLink } from "trpc-electron/renderer"
import type { AppRouter } from "../../main/trpc/appRouter"

let lastIpcRequestId = 0

/** Give every client in this document a distinct IPC operation ID. */
const uniqueIpcIds: TRPCLink<AppRouter> =
  () =>
  ({ op, next }) => {
    if (lastIpcRequestId === Number.MAX_SAFE_INTEGER)
      throw new Error("IPC request IDs exhausted; reload PI Lab")
    lastIpcRequestId += 1
    return next({ ...op, id: lastIpcRequestId })
  }

/**
 * Typed tRPC client over Electron IPC. Independent clients share a request-ID
 * sequence, and the preload bridge scopes those IDs to the current document.
 * SuperJSON must match the main router. Components can inject fake clients.
 */
export function createPiLabTrpcClient() {
  return createTRPCClient<AppRouter>({
    links: [uniqueIpcIds, ipcLink({ transformer: superjson })],
  })
}

export type PiLabTrpcClient = ReturnType<typeof createPiLabTrpcClient>
