import { randomUUID } from "node:crypto"
import { constants, existsSync } from "node:fs"
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  getAgentSettingsOrDefaults,
  getSettingsOrDefaults,
  type Project,
  type ProjectType,
  projects,
  resolveDataDir,
} from "@pi-lab/local-db"
import { buildLaunchArgv, buildNonInteractiveLaunchArgv, getAgent } from "@pi-lab/shared"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { agentLaunchLifecycle } from "../../agents/launchLifecycle"
import type { NonInteractiveProcessResult } from "../../automations/nonInteractiveRunner"
import type { AppContext } from "../context"
import { resolveWritableTemplateDir, seedWritableTemplate } from "../template"
import { publicProcedure } from "../trpc"

const proposalFile = "PROPOSED_RESEARCH.md"
const sectionPrefix = "## PI Lab project instructions:"
const sectionStart = "<!-- PI Lab project instructions start -->"
const sectionEnd = "<!-- PI Lab project instructions end -->"

const planDraftSchema = z.object({
  projectId: z.string(),
  stageDir: z.string(),
  originalResearch: z.string().nullable(),
  originalAgents: z.string().nullable(),
  proposedAgents: z.string(),
  name: z.string(),
  typeId: z.string(),
  sessionId: z.string().nullable(),
  mode: z.enum(["one-shot", "interactive"]),
  state: z.enum(["running", "ready", "failed"]),
  error: z.string().nullable(),
})
type PlanDraft = z.infer<typeof planDraftSchema>

function draftDirectory(draftId: string): string {
  return join(resolveDataDir(), "planning", z.string().uuid().parse(draftId))
}

/** Persist draft metadata outside the agent's working directory. */
async function writeDraft(draftId: string, draft: PlanDraft): Promise<void> {
  const path = join(draftDirectory(draftId), "draft.json")
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(draft), { mode: 0o600 })
  await rename(temporary, path)
}

async function readDraft(draftId: string): Promise<PlanDraft | null> {
  const raw = await readOptional(join(draftDirectory(draftId), "draft.json"))
  return raw === null ? null : planDraftSchema.parse(JSON.parse(raw))
}

/** Read durable pending drafts, including sessions created before app restart. */
async function listDrafts(): Promise<{ draftId: string; draft: PlanDraft }[]> {
  const directory = join(resolveDataDir(), "planning")
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  const result: { draftId: string; draft: PlanDraft }[] = []
  for (const draftId of entries) {
    if (!z.string().uuid().safeParse(draftId).success) continue
    const draft = await readDraft(draftId)
    if (draft) result.push({ draftId, draft })
  }
  return result
}

export async function listPlanningAgentSessions(): Promise<
  { draftId: string; projectId: string; sessionId: string }[]
> {
  return (await listDrafts()).flatMap(({ draftId, draft }) =>
    draft.sessionId ? [{ draftId, projectId: draft.projectId, sessionId: draft.sessionId }] : [],
  )
}

/** Retire planning terminals only after the daemon confirms they are absent or stopped. */
export async function reconcilePlanningSessions(
  liveSessionIds: ReadonlySet<string>,
): Promise<void> {
  for (const { draftId, draft } of await listDrafts()) {
    if (!draft.sessionId || liveSessionIds.has(draft.sessionId)) continue
    draft.sessionId = null
    draft.state = "failed"
    draft.error = "The planning agent has stopped. Review any saved proposal or discard the draft."
    await writeDraft(draftId, draft)
  }
}

/** Complete a one-shot draft after normal execution or daemon recovery. */
export async function completePlanningProcess(
  metadata: Record<string, string>,
  result: NonInteractiveProcessResult,
): Promise<void> {
  if (metadata.kind !== "planning" || !metadata.draftId) return
  const draft = await readDraft(metadata.draftId)
  if (!draft) return
  const failed = result.error !== null || result.signal !== null || result.code !== 0
  draft.state = failed ? "failed" : "ready"
  draft.error = failed
    ? result.error || result.stderr || `Planning agent stopped (${result.signal ?? result.code})`
    : null
  await writeDraft(metadata.draftId, draft)
}

const startInput = z.object({
  id: z.string().min(1),
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]+$/),
  description: z.string().trim().min(1).max(5_000),
  typeId: z.string().min(1),
  customInstructions: z.string().max(20_000),
  agentId: z.string().min(1),
  mode: z.enum(["one-shot", "interactive"]),
})
const draftInput = z.object({ draftId: z.string().uuid() })

/** Read an optional project Markdown file without creating it. */
async function readOptional(path: string): Promise<string | null> {
  return existsSync(path) ? readFile(path, "utf8") : null
}

/** Read only regular project-root files; symlinks cannot supply wizard context. */
async function readProjectFile(path: string): Promise<string | null> {
  const state = await lstat(path).then(
    (stat) => stat,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    },
  )
  if (!state) return null
  if (!state.isFile()) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Project Markdown must be a regular file" })
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return await file.readFile({ encoding: "utf8" })
  } finally {
    await file.close()
  }
}

/** Write an already reviewed project file without following a swapped-in symlink. */
async function writeProjectFile(path: string, content: string, existing: boolean): Promise<void> {
  const flags = existing
    ? constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
  const file = await open(path, flags, 0o644)
  try {
    await file.writeFile(content)
  } finally {
    await file.close()
  }
}

/** Replace only the app-owned section when a wizard is run again. */
function withProjectInstructions(
  base: string,
  name: string,
  type: ProjectType,
  custom: string,
): string {
  const parts = [
    sectionStart,
    `${sectionPrefix} ${name}\n`,
    `### Project type: ${type.name}\n${type.guidance.trim()}\n`,
  ]
  if (custom.trim()) parts.push(`### Custom instructions\n${custom.trim()}\n`)
  parts.push(sectionEnd)
  const section = parts.join("\n").trimEnd()
  const markedStart = base.indexOf(sectionStart)
  const markedEnd = base.indexOf(sectionEnd, markedStart + sectionStart.length)
  if (markedStart >= 0 && markedEnd >= 0) {
    return [
      base.slice(0, markedStart).trimEnd(),
      section,
      base.slice(markedEnd + sectionEnd.length).trimStart(),
    ]
      .filter(Boolean)
      .join("\n\n")
      .concat("\n")
  }
  const lines = base.split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith(sectionPrefix))
  if (start < 0) return `${base.trimEnd()}\n\n${section}\n`
  let end = start + 1
  while (end < lines.length && !/^## (?!#)/.test(lines[end] ?? "")) end += 1
  return `${[...lines.slice(0, start), ...section.split("\n"), ...lines.slice(end)].join("\n").trimEnd()}\n`
}

/** Prefill the user's instructions when setup is reopened. */
function customInstructionsFromAgents(content: string): string {
  const start = content.indexOf(sectionStart)
  const end = content.indexOf(sectionEnd, start + sectionStart.length)
  if (start < 0 || end < 0) return ""
  const section = content.slice(start, end)
  const heading = "### Custom instructions\n"
  const customStart = section.indexOf(heading)
  return customStart < 0 ? "" : section.slice(customStart + heading.length).trim()
}

/** Copy only the Markdown context the basic setup agent needs into an isolated folder. */
async function makeStage(
  project: Project,
  draftId: string,
  proposedAgents: string,
  originalResearch: string | null,
): Promise<string> {
  let taskSource: string | null = null
  if (project.taskRelPath) {
    const root = await realpath(project.repoPath)
    const candidate = resolve(root, project.taskRelPath)
    const pathWithinRoot = relative(root, candidate)
    if (
      isAbsolute(project.taskRelPath) ||
      pathWithinRoot === ".." ||
      pathWithinRoot.startsWith(`..${sep}`)
    ) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Task Markdown is outside the project" })
    }
    taskSource = await realpath(candidate)
    const realPathWithinRoot = relative(root, taskSource)
    if (realPathWithinRoot === ".." || realPathWithinRoot.startsWith(`..${sep}`)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Task Markdown is outside the project" })
    }
  }
  const stageDir = join(draftDirectory(draftId), "stage")
  await mkdir(stageDir, { recursive: true, mode: 0o700 })
  await writeFile(join(stageDir, "AGENTS.md"), proposedAgents)
  if (originalResearch !== null) await writeFile(join(stageDir, "RESEARCH.md"), originalResearch)
  if (project.taskRelPath && taskSource) {
    await copyFile(taskSource, join(stageDir, "TASK_SOURCE.md"))
  }
  return stageDir
}

/** Build the agent's constrained basic project-definition task. */
function planningPrompt(name: string, description: string, type: ProjectType): string {
  return [
    "Draft or refine this project's RESEARCH.md in the current planning folder.",
    `Write the complete proposed document to ${proposalFile}.`,
    "Read RESEARCH.md, AGENTS.md, and TASK_SOURCE.md here when present. Do not edit these input files.",
    "Do not work outside this planning folder. This is basic setup, not scientific-question planning.",
    `Project name: ${name}`,
    `Short description: ${description}`,
    `Project type: ${type.name}`,
    `Type guidance: ${type.guidance}`,
  ].join("\n")
}

/** Shared draft lifecycle used by both one-shot and interactive CLI modes. */
export const planningProcedures = {
  pendingPlans: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) =>
      (await listDrafts())
        .filter(({ draft }) => draft.projectId === input.id)
        .map(({ draftId, draft }) => ({
          draftId,
          name: draft.name,
          typeId: draft.typeId,
          sessionId: draft.sessionId,
          mode: draft.mode,
          state: draft.state,
          error: draft.error,
        })),
    ),
  getPlanDefaults: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const project = ctx.db.select().from(projects).where(eq(projects.id, input.id)).get()
      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
      const agents = await readProjectFile(join(project.repoPath, "AGENTS.md"))
      return { customInstructions: customInstructionsFromAgents(agents ?? "") }
    }),
  startPlan: publicProcedure.input(startInput).mutation(async ({ ctx, input }) => {
    const project = ctx.db.select().from(projects).where(eq(projects.id, input.id)).get()
    if (!project) throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
    const type = getSettingsOrDefaults(ctx.db).projectTemplate.projectTypes.find(
      (candidate) => candidate.id === input.typeId,
    )
    if (!type) throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown project type" })
    const agent = getAgent(input.agentId, ctx.agentCatalog)
    if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: `No agent ${input.agentId}` })
    const originalResearch = await readProjectFile(join(project.repoPath, "RESEARCH.md"))
    const originalAgents = await readProjectFile(join(project.repoPath, "AGENTS.md"))
    await seedWritableTemplate()
    const templateAgents = await readProjectFile(join(resolveWritableTemplateDir(), "AGENTS.md"))
    const baseAgents = originalAgents ?? templateAgents ?? ""
    const proposedAgents = withProjectInstructions(
      baseAgents,
      input.name,
      type,
      input.customInstructions,
    )
    const prompt = planningPrompt(input.name, input.description, type)
    const configured = getAgentSettingsOrDefaults(ctx.db).executableOverrides[agent.id]?.trim()
    const argv =
      input.mode === "one-shot"
        ? buildNonInteractiveLaunchArgv(
            agent,
            prompt,
            getAgentSettingsOrDefaults(ctx.db).launchDefaults[agent.id],
          )
        : buildLaunchArgv(agent, {
            ...getAgentSettingsOrDefaults(ctx.db).launchDefaults[agent.id],
            args: [prompt],
          })
    const [catalogCommand, ...args] = argv
    const command = await ctx.resolveAgentExecutable(configured || catalogCommand || "")
    if (!command)
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `${agent.label} is not available`,
      })
    const env = { ...(await ctx.getAgentLaunchEnvironment()), ...agent.env }
    const draftId = randomUUID()
    const stageDir = await makeStage(project, draftId, proposedAgents, originalResearch)
    const draft: PlanDraft = {
      projectId: project.id,
      stageDir,
      originalResearch,
      originalAgents,
      proposedAgents,
      name: input.name,
      typeId: input.typeId,
      sessionId: null,
      mode: input.mode,
      state: "running",
      error: null,
    }
    await writeDraft(draftId, draft)

    const launch = async () => {
      if (input.mode === "one-shot") {
        const started = await ctx.runNonInteractiveProcess({
          command,
          args,
          cwd: stageDir,
          env,
          timeoutMs: 600_000,
          metadata: { kind: "planning", draftId, projectId: project.id },
        })
        const result = await started.completion
        await completePlanningProcess({ kind: "planning", draftId }, result)
        await started.acknowledge?.()
        if (result.error || result.signal || result.code !== 0) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: result.error || result.stderr || `${agent.label} failed`,
          })
        }
      } else {
        await agentLaunchLifecycle.run(async () => {
          const client = await ctx.getDaemonClient()
          const spawned = await client.spawn({
            command,
            args,
            cwd: stageDir,
            env,
            cols: 80,
            rows: 24,
          })
          draft.sessionId = spawned.id
          await writeDraft(draftId, draft).catch(async (error: unknown) => {
            await client.kill(spawned.id)
            throw error
          })
        })
      }
    }
    await launch().catch(async (error: unknown) => {
      draft.state = "failed"
      draft.error = String(error)
      await writeDraft(draftId, draft)
      throw error
    })
    return { draftId, sessionId: draft.sessionId }
  }),

  reviewPlan: publicProcedure.input(draftInput).query(async ({ input }) => {
    const draft = await readDraft(input.draftId)
    if (!draft) throw new TRPCError({ code: "NOT_FOUND", message: "Planning draft not found" })
    const proposed = await readOptional(join(draft.stageDir, proposalFile))
    if (!proposed?.trim()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `The agent has not written ${proposalFile} yet`,
      })
    }
    await writeFile(
      join(draftDirectory(input.draftId), "reviewed.json"),
      JSON.stringify(proposed),
      { mode: 0o600 },
    )
    return {
      researchOriginal: draft.originalResearch ?? "",
      researchProposed: proposed,
      agentsOriginal: draft.originalAgents ?? "",
      agentsProposed: draft.proposedAgents,
    }
  }),

  applyPlan: publicProcedure
    .input(draftInput.extend({ researchContent: z.string().min(1).max(1_000_000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const draft = await readDraft(input.draftId)
      if (!draft) throw new TRPCError({ code: "NOT_FOUND", message: "Planning draft not found" })
      const reviewed = await readOptional(join(draftDirectory(input.draftId), "reviewed.json"))
      if (reviewed === null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Review the proposal before applying it",
        })
      }
      const project = ctx.db.select().from(projects).where(eq(projects.id, draft.projectId)).get()
      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" })
      const researchPath = join(project.repoPath, "RESEARCH.md")
      const agentsPath = join(project.repoPath, "AGENTS.md")
      if (
        (await readProjectFile(researchPath)) !== draft.originalResearch ||
        (await readProjectFile(agentsPath)) !== draft.originalAgents
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "RESEARCH.md or AGENTS.md changed during review",
        })
      }
      if (
        !getSettingsOrDefaults(ctx.db).projectTemplate.projectTypes.some(
          (type) => type.id === draft.typeId,
        )
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "Project type was removed during review" })
      }
      await stopInteractiveDraft(ctx, draft)
      await writeProjectFile(
        researchPath,
        input.researchContent ?? z.string().parse(JSON.parse(reviewed)),
        draft.originalResearch !== null,
      )
      await writeProjectFile(agentsPath, draft.proposedAgents, draft.originalAgents !== null).catch(
        async (error: unknown) => {
          if (draft.originalResearch === null) await rm(researchPath, { force: true })
          else await writeProjectFile(researchPath, draft.originalResearch, true)
          throw error
        },
      )
      const row = ctx.db
        .update(projects)
        .set({ name: draft.name, typeId: draft.typeId, updatedAt: Date.now() })
        .where(eq(projects.id, project.id))
        .returning()
        .get()
      await rm(draftDirectory(input.draftId), { recursive: true, force: true })
      return row
    }),

  discardPlan: publicProcedure.input(draftInput).mutation(async ({ ctx, input }) => {
    const draft = await readDraft(input.draftId)
    if (!draft) throw new TRPCError({ code: "NOT_FOUND", message: "Planning draft not found" })
    await stopInteractiveDraft(ctx, draft)
    await rm(draftDirectory(input.draftId), { recursive: true, force: true })
    return { discarded: true as const }
  }),
}

/** Stop only a planning PTY that is still alive before deleting its folder. */
async function stopInteractiveDraft(ctx: AppContext, draft: PlanDraft): Promise<void> {
  if (!draft.sessionId) return
  const client = await ctx.getDaemonClient()
  const session = (await client.list()).find((entry) => entry.id === draft.sessionId)
  if (session?.alive) await client.kill(draft.sessionId)
}
