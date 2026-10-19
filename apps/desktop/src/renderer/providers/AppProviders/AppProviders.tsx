import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useState } from "react"
import { createPiLabTrpcClient, type PiLabTrpcClient } from "../../trpc/client"
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

  return (
    <QueryClientProvider client={queryClientInstance}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClientInstance}>
        <ThemeProvider>{children}</ThemeProvider>
      </TRPCProvider>
    </QueryClientProvider>
  )
}
