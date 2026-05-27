import { healthRouter } from "./health/health"
import { router } from "./trpc"

/**
 * The single root router exposed to the renderer (AGENTS.md §6). Feature routers
 * (projects, workspaces, git, terminal, filesystem, automations, science-*)
 * mount here as later phases land — each as a one-line sub-router so its logic
 * stays in plain, `createCaller`-testable functions (AGENTS.md §14).
 */
export const appRouter = router({
  health: healthRouter,
})

/** Renderer-side type for the typed tRPC client. Types only — never imported at runtime. */
export type AppRouter = typeof appRouter
