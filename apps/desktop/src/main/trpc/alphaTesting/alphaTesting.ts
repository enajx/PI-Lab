import {
  agentSettings,
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_CAFFEINE_SETTINGS,
  DEFAULT_EDITOR_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  projects,
  settings,
} from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import type { AppContext } from "../context"
import { publicProcedure, router } from "../trpc"

function requireAlpha(ctx: AppContext): void {
  if (ctx.appChannel !== "alpha") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "These reset actions are available in Alpha only",
    })
  }
}

/** Test-only resets leave user-owned project folders and encrypted credentials alone. */
export const alphaTestingRouter = router({
  clearProjects: publicProcedure.mutation(async ({ ctx }): Promise<{ cleared: number }> => {
    requireAlpha(ctx)
    const allProjects = ctx.db.select().from(projects).all()
    if (allProjects.length === 0) return { cleared: 0 }

    if (allProjects.some((project) => ctx.activityMonitor.liveAgentCount(project.id) > 0)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Close active project agents before clearing the project list",
      })
    }
    const daemon = await ctx.getDaemonClient()
    const [sessions, processes] = await Promise.all([daemon.list(), daemon.listProcesses()])
    if (sessions.some((session) => session.alive) || processes.some((process) => process.alive)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Close active terminals and background runs before clearing the project list",
      })
    }

    ctx.db.delete(projects).run()
    return { cleared: allProjects.length }
  }),

  resetPreferences: publicProcedure.mutation(({ ctx }): { ok: true } => {
    requireAlpha(ctx)
    ctx.db.transaction((tx) => {
      tx.update(settings)
        .set({
          theme: "system",
          editorFontFamily: null,
          editorFontSize: null,
          terminalFontFamily: null,
          terminalFontSize: null,
          agentPresets: [],
          confirmOnQuit: true,
          keepRunningAfterClose: true,
          publicUpdateChannel: "stable",
          worktreePerAgent: false,
          editor: DEFAULT_EDITOR_SETTINGS,
          notifications: DEFAULT_NOTIFICATION_SETTINGS,
          caffeine: DEFAULT_CAFFEINE_SETTINGS,
          updatedAt: Date.now(),
        })
        .run()
      tx.update(agentSettings)
        .set({
          quitBehavior: DEFAULT_AGENT_SETTINGS.quitBehavior,
          defaultAgentId: DEFAULT_AGENT_SETTINGS.defaultAgentId,
          launchDefaults: DEFAULT_AGENT_SETTINGS.launchDefaults,
          projectConfigStorage: DEFAULT_AGENT_SETTINGS.projectConfigStorage,
          executableOverrides: DEFAULT_AGENT_SETTINGS.executableOverrides,
          setupCompleted: false,
          updatedAt: Date.now(),
        })
        .run()
    })
    ctx.caffeine.configure(DEFAULT_CAFFEINE_SETTINGS)
    return { ok: true }
  }),
})
