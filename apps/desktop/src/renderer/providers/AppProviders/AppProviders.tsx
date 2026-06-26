import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useState } from "react"
import { createSkipperTrpcClient, type SkipperTrpcClient } from "../../trpc/client"
import { TRPCProvider } from "../../trpc/react"
import { ThemeProvider } from "../ThemeProvider"

interface AppProvidersProps {
  children: ReactNode
  /**
   * Injectable tRPC client for tests (docs/testing-and-build.md). Defaults to the real IPC
   * client. The same client instance backs both the React/Query layer (reads)
   * and the vanilla observable path (subscriptions, e.g. the terminal).
   */
  client?: SkipperTrpcClient
  /** Injectable QueryClient for tests; defaults to a fresh per-mount instance. */
  queryClient?: QueryClient
}

/**
 * Root renderer providers (docs/architecture.md (renderer)): TanStack Query + tRPC-React over the
 * IPC link, wrapped by the theme provider. Both clients are created once per
 * mount (via `useState` initializers) so React 19 StrictMode's double-render
 * never spawns duplicate clients, and both are overridable for tests.
 */
export function AppProviders({ children, client, queryClient }: AppProvidersProps) {
  const [trpcClient] = useState<SkipperTrpcClient>(() => client ?? createSkipperTrpcClient())
  const [queryClientInstance] = useState<QueryClient>(() => queryClient ?? new QueryClient())

  return (
    <QueryClientProvider client={queryClientInstance}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClientInstance}>
        <ThemeProvider>{children}</ThemeProvider>
      </TRPCProvider>
    </QueryClientProvider>
  )
}
