import { createTRPCContext } from "@trpc/tanstack-react-query"
import type { AppRouter } from "../../main/trpc/appRouter"

/**
 * tRPC v11 React integration (the recommended `@trpc/tanstack-react-query`
 * approach, not the legacy `createTRPCReact`). It gives us a `TRPCProvider` to
 * mount under TanStack Query and a `useTRPC()` hook that returns *query-option
 * factories* — e.g. `useQuery(trpc.health.ping.queryOptions(input))` — so all
 * server reads flow through one `QueryClient`.
 *
 * Subscriptions are deliberately NOT routed through this React layer: over
 * `trpc-electron` they must consume observables (AGENTS.md Pitfalls #1), and the
 * observable-driven path (the live terminal) keeps using the vanilla client in
 * `./client.ts`. This split is intentional and documented.
 */
export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>()
