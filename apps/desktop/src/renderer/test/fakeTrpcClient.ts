import { createTRPCClient, type TRPCLink } from "@trpc/client"
import { observable } from "@trpc/server/observable"
import type { AppRouter } from "../../main/trpc/appRouter"
import type { SkipperTrpcClient } from "../trpc/client"

/**
 * A handler for one procedure path (dot-joined, e.g. `"files.read"`). Receives
 * the call's input and returns the value the procedure would resolve to.
 */
export type FakeHandler = (input: unknown) => unknown | Promise<unknown>

/** Map of procedure path → handler (the fake server's surface for a test). */
export type FakeHandlers = Record<string, FakeHandler>

/**
 * Build a *real* tRPC client backed by an in-memory terminating link instead of
 * the IPC link, so component tests can drive `useTRPC()` reads/mutations without
 * a main process (AGENTS.md §14). The `@trpc/tanstack-react-query` integration
 * resolves calls through the untyped client, so a hand-rolled plain object won't
 * do — this returns a genuine client whose link dispatches each operation to the
 * handler registered for its path, erroring clearly on an unhandled path.
 */
export function createFakeTrpcClient(handlers: FakeHandlers): SkipperTrpcClient {
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        const handler = handlers[op.path]
        if (!handler) {
          observer.error(new Error(`Fake tRPC client: no handler for "${op.path}"`) as never)
          return
        }
        Promise.resolve(handler(op.input))
          .then((data) => {
            observer.next({ result: { type: "data", data } })
            observer.complete()
          })
          .catch((error) => observer.error(error as never))
      })

  return createTRPCClient<AppRouter>({ links: [link] })
}
