import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { createPiLabTrpcClient, type PiLabTrpcClient } from "../../trpc/client"
import { connectionStatus } from "../../trpc/connectionStatus"
import { TRPCProvider } from "../../trpc/react"
import { ThemeProvider } from "../ThemeProvider"

interface AppProvidersProps {
  children: ReactNode
  /**
   * Injectable tRPC client for tests. Defaults to the real IPC
   * client. The same client instance backs both the React/Query layer (reads)
   * and the vanilla observable path (subscriptions, e.g. the terminal).
   */
  client?: PiLabTrpcClient
  /** Injectable QueryClient for tests; defaults to a fresh per-mount instance. */
  queryClient?: QueryClient
}

/**
 * Root renderer providers: TanStack Query + tRPC-React over the
 * IPC link, wrapped by the theme provider. Both clients are created once per
 * mount (via `useState` initializers) so React 19 StrictMode's double-render
 * never spawns duplicate clients, and both are overridable for tests.
 */
export function AppProviders({ children, client, queryClient }: AppProvidersProps) {
  const [trpcClient] = useState<PiLabTrpcClient>(() => client ?? createPiLabTrpcClient())
  const [queryClientInstance] = useState<QueryClient>(
    () =>
      queryClient ??
      new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } }),
  )

  // After the calls socket drops and opens again (a restarted server, or a call
  // lost with the socket), every query refetches: queries do not retry, and data
  // read from the old server may be stale.
  useEffect(
    () =>
      connectionStatus.onReopened((name) => {
        if (name === "calls") void queryClientInstance.invalidateQueries()
      }),
    [queryClientInstance],
  )

  return (
    <QueryClientProvider client={queryClientInstance}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClientInstance}>
        <ThemeProvider>{children}</ThemeProvider>
      </TRPCProvider>
    </QueryClientProvider>
  )
}
