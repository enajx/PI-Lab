import { agentsRouter } from "./agents"
import { automationsRouter } from "./automations"
import { diagnosticsRouter } from "./diagnostics"
import { filesRouter } from "./files"
import { healthRouter } from "./health/health"
import { projectsRouter } from "./projects"
import { scienceRouter } from "./science"
import { sessionsRouter } from "./sessions"
import { settingsRouter } from "./settings"
import { systemRouter } from "./system"
import { terminalRouter } from "./terminal/terminal"
import { router } from "./trpc"
import { workspacesRouter } from "./workspaces"

/**
 * The single root router exposed to the renderer (AGENTS.md §6). Feature routers
 * (git, github, filesystem, automations, science-*) mount here as later phases
 * land — each as a one-line sub-router so its logic stays in plain,
 * `createCaller`-testable functions (AGENTS.md §14).
 */
export const appRouter = router({
  health: healthRouter,
  terminal: terminalRouter,
  projects: projectsRouter,
  workspaces: workspacesRouter,
  sessions: sessionsRouter,
  system: systemRouter,
  files: filesRouter,
  diagnostics: diagnosticsRouter,
  science: scienceRouter,
  agents: agentsRouter,
  automations: automationsRouter,
  settings: settingsRouter,
})

/** Renderer-side type for the typed tRPC client. Types only — never imported at runtime. */
export type AppRouter = typeof appRouter
