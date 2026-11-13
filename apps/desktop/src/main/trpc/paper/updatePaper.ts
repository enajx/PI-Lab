import { join } from "node:path"
import { getAgentSettingsOrDefaults, getSettingsOrDefaults, projects } from "@pi-lab/local-db"
import { DEFAULT_AGENT_ID } from "@pi-lab/shared"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import { readProjectAgentConfig } from "../../agents/projectConfig"
import { mainDocOf } from "../../paper/outputs"
import type { AppContext } from "../context"
import { type StartSessionResult, startAgentSession } from "../sessions/sessions"
import { findSkill } from "../workflows/planResearchSkill"

/** An Update paper launch: the started session and the agent it runs. */
export interface StartUpdatePaperResult extends StartSessionResult {
  agentId: string
}

/**
 * The LaTeX Editor's Update paper button: start the project's agent
 * (remembered choice, else the default) as a LaTeX Editor agent, with a
 * prompt that triggers the `write-research` skill (PI Lab's bundled copy
 * first, then project and user skills) and names the paper folder and its
 * main .tex. Throws, starting nothing, when the project has no paper folder
 * or the skill cannot be found.
 */
export async function startUpdatePaper(
  ctx: AppContext,
  projectId: string,
): Promise<StartUpdatePaperResult> {
  const project = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: `No project ${projectId}` })
  const paper = project.metadata?.paper
  if (!paper) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This project has no paper folder",
    })
  }
  const skill = await findSkill(
    "write-research",
    "Write research",
    project.repoPath,
    ctx.skillsHomeDir,
    ctx.bundledSkillsDir,
  )
  const root = await mainDocOf(paper, null, getSettingsOrDefaults(ctx.db).editor.latexOutputDir)
  const agentSettings = getAgentSettingsOrDefaults(ctx.db)
  const config = await readProjectAgentConfig(project, agentSettings.projectConfigStorage)
  const agentId = config.agentId ?? agentSettings.defaultAgentId ?? DEFAULT_AGENT_ID
  const paperLine = root
    ? `The paper folder is ${paper.dir} and its main .tex file is ${join(paper.dir, root)}.`
    : `The paper folder is ${paper.dir}; PI Lab found no main .tex file in it.`
  const result = await startAgentSession(ctx, {
    projectId: project.id,
    agentId,
    origin: "latex",
    workspaceMode: "policy",
    prompt: `Use the write-research skill to update this project's paper. Its SKILL.md is at ${skill.path}. Follow its instructions. ${paperLine}`,
  })
  return { ...result, agentId }
}
