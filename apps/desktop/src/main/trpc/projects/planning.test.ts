import { existsSync } from "node:fs"
import { chmod, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { projects } from "@pi-lab/local-db"
import type { TerminalAgent } from "@pi-lab/shared"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { NonInteractiveProcessInput } from "../../automations/nonInteractiveRunner"
import { createHarness, type Harness } from "../testHarness"

const agent: TerminalAgent = {
  id: "codex",
  label: "Codex",
  command: process.execPath,
  detect: "node",
  defaultArgs: [],
}

let h: Harness
let stagedPath: string
let proposalPresentBeforeRun: boolean

beforeEach(async () => {
  proposalPresentBeforeRun = false
  h = await createHarness([agent], {
    runNonInteractiveProcess: async (input: NonInteractiveProcessInput) => {
      stagedPath = input.cwd
      proposalPresentBeforeRun = existsSync(join(input.cwd, "PROPOSED_RESEARCH.md"))
      await writeFile(join(input.cwd, "PROPOSED_RESEARCH.md"), "# New research plan\n")
      return {
        completion: Promise.resolve({ code: 0, signal: null, stdout: "", stderr: "", error: null }),
      }
    },
  })
})

afterEach(async () => {
  await h.dispose()
})

describe("project planning", () => {
  test("stages an agent draft and project instructions until the user applies both", async () => {
    await writeFile(join(h.repoDir, "RESEARCH.md"), "# Existing research\n")
    await writeFile(join(h.repoDir, "AGENTS.md"), "# Existing instructions\n")
    const project = await h.caller.projects.open({ path: h.repoDir })

    const started = await h.caller.projects.startPlan({
      id: project.id,
      name: "My project",
      description: "Study a measurement.",
      typeId: "paper",
      customInstructions: "Use SI units.",
      agentId: "codex",
      mode: "one-shot",
    })

    expect(started.sessionId).toBeNull()
    expect(stagedPath).not.toBe(h.repoDir)
    expect(await readFile(join(h.repoDir, "RESEARCH.md"), "utf8")).toBe("# Existing research\n")
    expect(await readFile(join(h.repoDir, "AGENTS.md"), "utf8")).toBe("# Existing instructions\n")

    const review = await h.caller.projects.reviewPlan({ draftId: started.draftId })
    expect(review.researchOriginal).toBe("# Existing research\n")
    expect(review.researchProposed).toBe("# New research plan\n")
    expect(review.agentsProposed).toContain("Use SI units.")
    expect(review.agentsProposed).toContain("## PI Lab project instructions: My project")
    expect(review.agentsProposed).toContain("Describe the paper question")

    await h.caller.projects.applyPlan({ draftId: started.draftId })
    expect(await readFile(join(h.repoDir, "RESEARCH.md"), "utf8")).toBe("# New research plan\n")
    expect(await readFile(join(h.repoDir, "AGENTS.md"), "utf8")).toContain("Use SI units.")
    expect((await h.caller.projects.get({ id: project.id })).typeId).toBe("paper")
    expect((await h.caller.projects.get({ id: project.id })).name).toBe("My project")
  })

  test("discard leaves existing files untouched", async () => {
    await writeFile(join(h.repoDir, "RESEARCH.md"), "# Keep me\n")
    const project = await h.caller.projects.open({ path: h.repoDir })
    const started = await h.caller.projects.startPlan({
      id: project.id,
      name: "Discarded name",
      description: "Discarded description",
      typeId: "research",
      customInstructions: "Discarded instructions",
      agentId: "codex",
      mode: "one-shot",
    })

    await h.caller.projects.discardPlan({ draftId: started.draftId })

    expect(await readFile(join(h.repoDir, "RESEARCH.md"), "utf8")).toBe("# Keep me\n")
    expect((await h.caller.projects.get({ id: project.id })).name).toBe("repo")
    await expect(h.caller.projects.reviewPlan({ draftId: started.draftId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  test("an adopted folder without AGENTS.md receives the shared template after Apply", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const started = await h.caller.projects.startPlan({
      id: project.id,
      name: "Adopted project",
      description: "A short description.",
      typeId: "research",
      customInstructions: "Use SI units.",
      agentId: "codex",
      mode: "one-shot",
    })
    const review = await h.caller.projects.reviewPlan({ draftId: started.draftId })
    expect(review.agentsOriginal).toBe("")
    expect(review.agentsProposed).toContain("## Repo structure")
    expect(review.agentsProposed).toContain("## PI Lab project instructions: Adopted project")
    await h.caller.projects.applyPlan({ draftId: started.draftId })
    expect(await readFile(join(h.repoDir, "AGENTS.md"), "utf8")).toContain("Use SI units.")
  })

  test("a later reviewed plan replaces only the named project instruction section", async () => {
    await writeFile(
      join(h.repoDir, "AGENTS.md"),
      "# Shared instructions\n\n## Keep this\nStay careful.\n",
    )
    const project = await h.caller.projects.open({ path: h.repoDir })
    const input = {
      id: project.id,
      name: "My project",
      description: "A short description.",
      typeId: "research",
      agentId: "codex",
      mode: "one-shot" as const,
    }
    const first = await h.caller.projects.startPlan({
      ...input,
      customInstructions: "First rule.\n## Nested detail\nOld detail.",
    })
    await h.caller.projects.reviewPlan({ draftId: first.draftId })
    await h.caller.projects.applyPlan({ draftId: first.draftId })
    expect((await h.caller.projects.getPlanDefaults({ id: project.id })).customInstructions).toBe(
      "First rule.\n## Nested detail\nOld detail.",
    )

    const second = await h.caller.projects.startPlan({
      ...input,
      customInstructions: "Second rule.",
    })
    const review = await h.caller.projects.reviewPlan({ draftId: second.draftId })
    expect(review.agentsOriginal).toContain("First rule.")
    expect(review.agentsProposed).not.toContain("First rule.")
    expect(review.agentsProposed).not.toContain("Old detail.")
    expect(review.agentsProposed).toContain("Second rule.")
    expect(review.agentsProposed).toContain("## Keep this\nStay careful.")
    await h.caller.projects.applyPlan({ draftId: second.draftId })

    const agents = await readFile(join(h.repoDir, "AGENTS.md"), "utf8")
    expect(agents.match(/## PI Lab project instructions:/g)).toHaveLength(1)
    expect(agents).toContain("## PI Lab project instructions: My project")
    expect(agents).toContain("## Keep this\nStay careful.")
  })

  test("interactive planning runs in the isolated folder and reports a missing proposal", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const started = await h.caller.projects.startPlan({
      id: project.id,
      name: "Interactive project",
      description: "A short description.",
      typeId: "research",
      customInstructions: "",
      agentId: "codex",
      mode: "interactive",
    })
    if (!started.sessionId) throw new Error("interactive session missing")
    const session = (await h.client.list()).find((item) => item.id === started.sessionId)
    if (!session) throw new Error("daemon session missing")
    expect(session.cwd).not.toBe(h.repoDir)
    await expect(h.caller.projects.reviewPlan({ draftId: started.draftId })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    })

    await writeFile(join(session.cwd, "PROPOSED_RESEARCH.md"), "# Interactive draft\n")
    const review = await h.caller.projects.reviewPlan({ draftId: started.draftId })
    expect(review.researchProposed).toBe("# Interactive draft\n")
    await h.caller.projects.discardPlan({ draftId: started.draftId })
    expect((await h.caller.projects.get({ id: project.id })).name).toBe("repo")
  })

  test("rejects a stored task source that points outside the project", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await writeFile(join(h.dataDir, "outside.md"), "# Outside\n")
    h.db
      .update(projects)
      .set({ taskRelPath: "../outside.md" })
      .where(eq(projects.id, project.id))
      .run()

    await expect(
      h.caller.projects.startPlan({
        id: project.id,
        name: "Project",
        description: "Description.",
        typeId: "research",
        customInstructions: "",
        agentId: "codex",
        mode: "one-shot",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  test("stages a task source named AGENTS.md without replacing proposed guidance", async () => {
    await writeFile(join(h.repoDir, "AGENTS.md"), "# Original task context\n")
    const project = await h.caller.projects.open({ path: h.repoDir })
    h.db.update(projects).set({ taskRelPath: "AGENTS.md" }).where(eq(projects.id, project.id)).run()
    const started = await h.caller.projects.startPlan({
      id: project.id,
      name: "Project",
      description: "Description.",
      typeId: "research",
      customInstructions: "New guidance.",
      agentId: "codex",
      mode: "one-shot",
    })
    expect(await readFile(join(stagedPath, "AGENTS.md"), "utf8")).toContain("New guidance.")
    expect(await readFile(join(stagedPath, "TASK_SOURCE.md"), "utf8")).toBe(
      "# Original task context\n",
    )
    await h.caller.projects.discardPlan({ draftId: started.draftId })
  })

  test("stages a task source named PROPOSED_RESEARCH.md without faking an agent proposal", async () => {
    await writeFile(join(h.repoDir, "PROPOSED_RESEARCH.md"), "# Existing task source\n")
    const project = await h.caller.projects.open({ path: h.repoDir })
    h.db
      .update(projects)
      .set({ taskRelPath: "PROPOSED_RESEARCH.md" })
      .where(eq(projects.id, project.id))
      .run()
    const started = await h.caller.projects.startPlan({
      id: project.id,
      name: "Project",
      description: "Description.",
      typeId: "research",
      customInstructions: "",
      agentId: "codex",
      mode: "one-shot",
    })
    expect(proposalPresentBeforeRun).toBe(false)
    expect(await readFile(join(stagedPath, "TASK_SOURCE.md"), "utf8")).toBe(
      "# Existing task source\n",
    )
    await h.caller.projects.discardPlan({ draftId: started.draftId })
  })

  test("a failed AGENTS write restores RESEARCH and allows the user to retry Apply", async () => {
    await writeFile(join(h.repoDir, "RESEARCH.md"), "# Original\n")
    await writeFile(join(h.repoDir, "AGENTS.md"), "# Original agents\n")
    const project = await h.caller.projects.open({ path: h.repoDir })
    const started = await h.caller.projects.startPlan({
      id: project.id,
      name: "Project",
      description: "Description.",
      typeId: "research",
      customInstructions: "Use SI units.",
      agentId: "codex",
      mode: "one-shot",
    })
    await h.caller.projects.reviewPlan({ draftId: started.draftId })
    const agentsPath = join(h.repoDir, "AGENTS.md")
    await chmod(agentsPath, 0o444)
    await expect(h.caller.projects.applyPlan({ draftId: started.draftId })).rejects.toThrow()
    expect(await readFile(join(h.repoDir, "RESEARCH.md"), "utf8")).toBe("# Original\n")
    await chmod(agentsPath, 0o644)
    await h.caller.projects.applyPlan({ draftId: started.draftId })
    expect(await readFile(join(h.repoDir, "RESEARCH.md"), "utf8")).toBe("# New research plan\n")
  })

  test("rejects project-root Markdown symlinks before reading or applying a draft", async () => {
    const outside = join(h.dataDir, "outside.md")
    await writeFile(outside, "# Outside\n")
    await symlink(outside, join(h.repoDir, "RESEARCH.md"))
    const project = await h.caller.projects.open({ path: h.repoDir })
    await expect(
      h.caller.projects.startPlan({
        id: project.id,
        name: "Project",
        description: "Description.",
        typeId: "research",
        customInstructions: "",
        agentId: "codex",
        mode: "one-shot",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(await readFile(outside, "utf8")).toBe("# Outside\n")
  })
})
