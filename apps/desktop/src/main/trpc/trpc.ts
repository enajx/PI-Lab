import { initTRPC } from "@trpc/server"
import superjson from "superjson"
import type { AppContext } from "./context"

/**
 * tRPC primitives for the main process. There is exactly one renderer↔main
 * contract — no inter-process HTTP hop — so a single root
 * builder is all we need. `superjson` is the wire transformer and MUST match
 * the renderer's `ipcLink` transformer or payloads silently corrupt.
 *
 * The router is typed over {@link AppContext} so feature routers (terminal) can
 * reach the PTY daemon; context-free routers (health) ignore it.
 */
const t = initTRPC.context<AppContext>().create({ transformer: superjson })

export const router = t.router
export const publicProcedure = t.procedure

/**
 * Direct, window-free procedure invocation for tests: call
 * routers via `createCaller` instead of spinning up a BrowserWindow.
 */
export const createCallerFactory = t.createCallerFactory
