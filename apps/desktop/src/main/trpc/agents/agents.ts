import { getAgentSettingsOrDefaults, projects } from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { readProjectAgentConfig, writeProjectAgentConfig } from "../../agents/projectConfig"
import { publicProcedure, router } from "../trpc"

/** A launchable agent as the renderer needs it, including resolved availability. */
export interface AgentOption {
  id: string
  label: string
  available: boolean
  executable: string
}

/**
 * Agents router — exposes the launchable external-CLI agent catalog (AGENTS.md
 * md/engineering/architecture.md (agent runtime)) to the renderer so pickers (the automation create form, future workspace
 * launchers) can offer a choice without hard-coding ids. The catalog is data on
 * the context (the built-ins, plus the deterministic test agent in test mode),
 * so this is a thin read. The resolved executable is shown for diagnosis, while
 * detection and launch remain in the main process.
 */
export const agentsRouter = router({
  list: publicProcedure.query(async ({ ctx }): Promise<AgentOption[]> => {
    const overrides = getAgentSettingsOrDefaults(ctx.db).executableOverrides
    return Promise.all(
      ctx.agentCatalog.map(async (agent) => {
        const configured = overrides[agent.id]?.trim()
        const candidate = configured || agent.command
        const resolved = await ctx.resolveAgentExecutable(candidate)
        return {
          id: agent.id,
          label: agent.label,
          available: resolved !== null,
          executable: resolved ?? candidate,
        }
      }),
    )
  }),

  projectChoice: publicProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const project = ctx.db.select().from(projects).where(eq(projects.id, input.projectId)).get()
      if (!project)
        throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.projectId}` })
      const storage = getAgentSettingsOrDefaults(ctx.db).projectConfigStorage
      const config = await readProjectAgentConfig(ctx.db, project, storage)
      return { agentId: config.agentId ?? null, storage }
    }),

  setProjectChoice: publicProcedure
    .input(z.object({ projectId: z.string().min(1), agentId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const project = ctx.db.select().from(projects).where(eq(projects.id, input.projectId)).get()
      if (!project)
        throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.projectId}` })
      if (!ctx.agentCatalog.some((agent) => agent.id === input.agentId)) {
        throw new TRPCError({ code: "NOT_FOUND", message: `No agent ${input.agentId}` })
      }
      const storage = getAgentSettingsOrDefaults(ctx.db).projectConfigStorage
      await writeProjectAgentConfig(ctx.db, project, storage, { agentId: input.agentId })
      return { agentId: input.agentId, storage }
    }),
})
