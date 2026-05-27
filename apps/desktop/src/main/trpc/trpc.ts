import { initTRPC } from "@trpc/server"
import superjson from "superjson"

/**
 * tRPC primitives for the main process. There is exactly one renderer↔main
 * contract (AGENTS.md §6) — no inter-process HTTP hop — so a single root
 * builder is all we need. `superjson` is the wire transformer and MUST match
 * the renderer's `ipcLink` transformer or payloads silently corrupt.
 */
const t = initTRPC.create({ transformer: superjson })

export const router = t.router
export const publicProcedure = t.procedure

/**
 * Direct, window-free procedure invocation for tests (AGENTS.md §14): call
 * routers via `createCaller` instead of spinning up a BrowserWindow.
 */
export const createCallerFactory = t.createCallerFactory
