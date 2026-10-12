import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server"
import type { AppRouter } from "../../main/trpc/appRouter"

/**
 * Renderer-side input/output types inferred from the main-process router. These
 * are **type-only** (`AppRouter` is never imported at runtime), so the renderer
 * stays decoupled from main's modules while still getting exact types for router
 * results — e.g. a workspace's git changes — without re-declaring them.
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>
export type RouterInputs = inferRouterInputs<AppRouter>

/** One working-tree change as returned by `workspaces.changes`. */
export type GitChange = RouterOutputs["workspaces"]["changes"][number]

/** One automation as returned by `automations.list` (incl. its cadence summary). */
export type AutomationListItem = RouterOutputs["automations"]["list"][number]

/** Full automation detail as returned by `automations.get`. */
export type AutomationDetail = RouterOutputs["automations"]["get"]

/** One firing as returned by `automations.listRuns`. */
export type AutomationRun = RouterOutputs["automations"]["listRuns"][number]

/** A launchable agent option as returned by `agents.list`. */
export type AgentOption = RouterOutputs["agents"]["list"][number]

/** A project as returned by `projects.list`. */
export type ProjectListItem = RouterOutputs["projects"]["list"][number]

/** One directory-listing entry as returned by `files.tree`. */
export type FileTreeEntry = RouterOutputs["files"]["tree"][number]

/** One quick-open hit as returned by `files.search`. */
export type FileSearchHit = RouterOutputs["files"]["search"]["hits"][number]
