import { publicProcedure, router } from "../trpc"

/** A launchable agent as the renderer needs it — id + label only (no command). */
export interface AgentOption {
  id: string
  label: string
}

/**
 * Agents router — exposes the launchable external-CLI agent catalog (AGENTS.md
 * docs/architecture.md (agent runtime)) to the renderer so pickers (the automation create form, future workspace
 * launchers) can offer a choice without hard-coding ids. The catalog is data on
 * the context (the built-ins, plus the deterministic test agent in test mode),
 * so this is a thin read. Only id + label cross the wire — the command / detect
 * binary stay in the main process.
 */
export const agentsRouter = router({
  list: publicProcedure.query(({ ctx }): AgentOption[] =>
    ctx.agentCatalog.map((agent) => ({ id: agent.id, label: agent.label })),
  ),
})
