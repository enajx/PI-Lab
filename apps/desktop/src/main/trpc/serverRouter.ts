import { serverControlRouter } from "../../server/controlRouter"
import { agentsRouter } from "./agents"
import { alphaTestingRouter } from "./alphaTesting/alphaTesting"
import { automationsRouter } from "./automations"
import { caffeineRouter } from "./caffeine"
import { diagnosticsRouter } from "./diagnostics"
import { diaryRouter } from "./diary/diary"
import { dictationRouter } from "./dictation/dictation"
import { documentsRouter } from "./documents/documents"
import { filesRouter } from "./files"
import { healthRouter } from "./health/health"
import { latexRouter } from "./latex/latex"
import { notebooksRouter } from "./notebooks/notebooks"
import { notificationsRouter } from "./notifications"
import { paperRouter } from "./paper/paper"
import { pdfRouter } from "./pdf/pdf"
import { projectsRouter } from "./projects"
import { pythonRouter } from "./python"
import { scienceRouter } from "./science"
import { sessionsRouter } from "./sessions"
import { settingsRouter } from "./settings"
import { setupRouter } from "./setup"
import { templateRouter } from "./template"
import { terminalRouter } from "./terminal/terminal"
import { router } from "./trpc"
import { workflowsRouter } from "./workflows"
import { workspacesRouter } from "./workspaces"

/**
 * Every namespace the PI Lab server serves. Feature routers mount here as
 * one-line sub-routers so their logic stays in plain, `createCaller`-testable
 * functions.
 */
export const serverProcedures = {
  server: serverControlRouter,
  alphaTesting: alphaTestingRouter,
  health: healthRouter,
  notifications: notificationsRouter,
  caffeine: caffeineRouter,
  terminal: terminalRouter,
  projects: projectsRouter,
  python: pythonRouter,
  workspaces: workspacesRouter,
  sessions: sessionsRouter,
  workflows: workflowsRouter,
  files: filesRouter,
  pdf: pdfRouter,
  latex: latexRouter,
  paper: paperRouter,
  diagnostics: diagnosticsRouter,
  dictation: dictationRouter,
  science: scienceRouter,
  diary: diaryRouter,
  documents: documentsRouter,
  notebooks: notebooksRouter,
  agents: agentsRouter,
  automations: automationsRouter,
  settings: settingsRouter,
  setup: setupRouter,
  template: templateRouter,
}

/**
 * The routers the PI Lab server serves: every namespace except the
 * Electron-only `system` one (see desktop/desktopRouter.ts).
 */
export const serverRouter = router(serverProcedures)

export type ServerRouter = typeof serverRouter
