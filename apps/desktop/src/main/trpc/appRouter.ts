import { agentsRouter } from "./agents"
import { automationsRouter } from "./automations"
import { caffeineRouter } from "./caffeine"
import { diagnosticsRouter } from "./diagnostics"
import { filesRouter } from "./files"
import { healthRouter } from "./health/health"
import { notificationsRouter } from "./notifications"
import { projectsRouter } from "./projects"
import { pythonRouter } from "./python"
import { scienceRouter } from "./science"
import { sessionsRouter } from "./sessions"
import { settingsRouter } from "./settings"
import { setupRouter } from "./setup"
import { systemRouter } from "./system"
import { templateRouter } from "./template"
import { terminalRouter } from "./terminal/terminal"
import { router } from "./trpc"
import { workspacesRouter } from "./workspaces"

/**
 * The single root router exposed to the renderer (md/engineering/architecture.md (process model)). Feature routers
 * (git, github, filesystem, automations, science-*) mount here as later phases
 * land — each as a one-line sub-router so its logic stays in plain,
 * `createCaller`-testable functions (md/engineering/testing-and-build.md).
 */
export const appRouter = router({
  health: healthRouter,
  notifications: notificationsRouter,
  caffeine: caffeineRouter,
  terminal: terminalRouter,
  projects: projectsRouter,
  python: pythonRouter,
  workspaces: workspacesRouter,
  sessions: sessionsRouter,
  system: systemRouter,
  files: filesRouter,
  diagnostics: diagnosticsRouter,
  science: scienceRouter,
  agents: agentsRouter,
  automations: automationsRouter,
  settings: settingsRouter,
  setup: setupRouter,
  template: templateRouter,
})

/** Renderer-side type for the typed tRPC client. Types only — never imported at runtime. */
export type AppRouter = typeof appRouter
