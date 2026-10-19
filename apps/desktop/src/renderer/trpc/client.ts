import { createTRPCClient } from "@trpc/client"
import superjson from "superjson"
import { ipcLink } from "trpc-electron/renderer"
import type { AppRouter } from "../../main/trpc/appRouter"

/**
 * Vanilla typed tRPC client over the `trpc-electron` IPC link. This phase makes
 * a plain imperative call for the health check; TanStack Query / the React
 * client are added in a later phase. The `superjson` transformer here MUST match
 * the main process's `initTRPC` transformer.
 *
 * Constructed via a factory (not a module singleton) so component tests can
 * inject a fake client.
 */
export function createPiLabTrpcClient() {
  return createTRPCClient<AppRouter>({
    links: [ipcLink({ transformer: superjson })],
  })
}

export type PiLabTrpcClient = ReturnType<typeof createPiLabTrpcClient>
