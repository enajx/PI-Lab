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
import { templateRouter } from "./template"
import { terminalRouter } from "./terminal/terminal"
import { router } from "./trpc"
import { workspacesRouter } from "./workspaces"

/**
 * The single root router exposed to the renderer (docs/architecture.md (process model)). Feature routers
 * (git, github, filesystem, automations, science-*) mount here as later phases
 * land — each as a one-line sub-router so its logic stays in plain,
 * `createCaller`-testable functions (docs/testing-and-build.md).
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
  template: templateRouter,
})

/** Renderer-side type for the typed tRPC client. Types only — never imported at runtime. */
export type AppRouter = typeof appRouter
