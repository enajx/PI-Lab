import { router } from "../trpc"
import { analysisRouter } from "./analysis"
import { clusterRouter } from "./cluster/cluster"
import { libraryRouter } from "./library"
import { skillsRouter } from "./skills/skills"
import { tasksRouter } from "./tasks"

/**
 * Science namespace (AGENTS.md "Scope" "Science tabs") — the umbrella for the
 * research-specific surfaces. v1 wires the **cluster** monitoring tab, the
 * **skills** read-only catalog, the **analysis** data browser, and the
 * **library** tab (Zotero). Mounted on the appRouter as
 * `science`, so the procedures are `science.cluster.*`, `science.skills.*`,
 * `science.analysis.*`, and `science.library.*`.
 */
export const scienceRouter = router({
  cluster: clusterRouter,
  skills: skillsRouter,
  analysis: analysisRouter,
  library: libraryRouter,
  tasks: tasksRouter,
})
