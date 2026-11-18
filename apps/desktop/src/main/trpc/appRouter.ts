import { serverProcedures } from "./serverRouter"
import { systemRouter } from "./system"
import { router } from "./trpc"

/**
 * The full client contract: the server's routers plus the Electron-only
 * `system` router. The renderer's client is typed over it; a split link sends
 * each call to the server or to Electron (see renderer/trpc/client.ts).
 * Never served as one router.
 */
export const appRouter = router({ ...serverProcedures, system: systemRouter })

/** Renderer-side type for the typed tRPC client. Types only — never imported at runtime. */
export type AppRouter = typeof appRouter
