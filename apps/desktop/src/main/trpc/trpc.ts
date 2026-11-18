import { initTRPC } from "@trpc/server"
import type { AppContext } from "./context"

/**
 * Whether error replies carry the server's stack trace: only in test mode
 * (`PI_LAB_TEST_MODE=1`) or development (`NODE_ENV=development`).
 */
export function showErrorStacks(env: Record<string, string | undefined>): boolean {
  return env.PI_LAB_TEST_MODE === "1" || env.NODE_ENV === "development"
}

/**
 * tRPC primitives shared by the server router and the Electron desktop router.
 * No transformer: the client API is plain JSON (see shared/clientApi.ts), so
 * any client can call it without SuperJSON.
 *
 * The router is typed over {@link AppContext} so feature routers (terminal) can
 * reach the PTY daemon; context-free routers (health) ignore it.
 */
const t = initTRPC.context<AppContext>().create({ isDev: showErrorStacks(process.env) })

export const router = t.router
export const publicProcedure = t.procedure.use(async ({ ctx, path, type, next }) => {
  const result = await next()
  if (result.ok && type === "mutation" && path.startsWith("projects.")) {
    ctx.activityStatus.projectsChanged()
  }
  // Electron main keeps a copy of a few settings (Quit, window close, Vim).
  if (
    result.ok &&
    type === "mutation" &&
    (path.startsWith("settings.") || path.startsWith("server."))
  ) {
    ctx.server?.runtime.appSettingsChanged()
  }
  return result
})

/**
 * Direct, window-free procedure invocation for tests: call
 * routers via `createCaller` instead of spinning up a BrowserWindow.
 */
export const createCallerFactory = t.createCallerFactory
