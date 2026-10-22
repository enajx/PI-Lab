import { cp, mkdir, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { agentCredentials } from "@pi-lab/local-db"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { createHarness, type Harness } from "../testHarness"

describe("Alpha testing resets", () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await createHarness([], { git: false, daemon: "lazy" })
  })

  afterEach(async () => {
    await harness.dispose()
  })

  test("clear project list forgets projects without deleting their folders", async () => {
    const project = await harness.caller.projects.open({ path: harness.repoDir })
    expect(project.repoPath).toBe(harness.repoDir)
    await harness.caller.alphaTesting.clearProjects()
    expect(await harness.caller.projects.list()).toEqual([])
    expect((await stat(harness.repoDir)).isDirectory()).toBe(true)
  })

  test("all five prepared examples open as plain projects with the expected types", async () => {
    const examplesRoot = resolve(import.meta.dirname, "../../../../../../tests/test-projects")
    const samples = [
      ["python-research", "research"],
      ["julia-research", "research"],
      ["cpp-research", "research"],
      ["software-typescript", "software"],
      ["paper-latex", "manuscript"],
    ] as const
    const destination = resolve(harness.dataDir, "prepared-examples")
    await mkdir(destination)

    for (const [name, type] of samples) {
      const path = resolve(destination, name)
      await cp(resolve(examplesRoot, name), path, { recursive: true })
      const opened = await harness.caller.projects.open({ path })
      if (type === "manuscript")
        await harness.caller.projects.setType({ id: opened.id, typeId: "manuscript" })
      const project = await harness.caller.projects.get({ id: opened.id })
      expect(project.repoPath).toBe(path)
      expect(project.typeId).toBe(type)
      expect(project.defaultBranch).toBeNull()
    }
  })

  test("reset preferences repeats setup but keeps projects and credentials", async () => {
    const project = await harness.caller.projects.open({ path: harness.repoDir })
    await harness.caller.settings.updateGeneral({ confirmOnQuit: false })
    await harness.caller.settings.updateEditor({ vim: true })
    await harness.caller.settings.updateAgents({
      setupCompleted: true,
      defaultAgentId: "codex",
      launchDefaults: { codex: { model: "gpt-5", effort: "high" } },
    })
    await harness.caller.settings.updateProjectTemplate({
      defaultTemplateParentPath: "/test/templates",
    })
    harness.db
      .insert(agentCredentials)
      .values({ agentId: "test", encryptedValue: "encrypted" })
      .run()

    await harness.caller.alphaTesting.resetPreferences()

    const after = await harness.caller.settings.get()
    expect(after.confirmOnQuit).toBe(true)
    expect(after.editor.vim).toBe(false)
    expect(after.agents.setupCompleted).toBe(false)
    expect(after.agents.defaultAgentId).toBeNull()
    expect(after.agents.launchDefaults).toEqual({})
    expect(after.projectTemplate.defaultTemplateParentPath).toBe("/test/templates")
    expect((await harness.caller.projects.list()).map((item) => item.id)).toContain(project.id)
    expect(harness.db.select().from(agentCredentials).get()?.encryptedValue).toBe("encrypted")
  })

  test("clear project list refuses to orphan a live terminal", async () => {
    const project = await harness.caller.projects.open({ path: harness.repoDir })
    const { sessionId } = await harness.caller.terminal.spawn({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: project.repoPath,
      cols: 80,
      rows: 24,
    })
    await expect(harness.caller.alphaTesting.clearProjects()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    })
    expect((await harness.caller.projects.list()).map((item) => item.id)).toContain(project.id)
    await harness.caller.terminal.kill({ sessionId })
  })

  test("both reset actions are forbidden outside Alpha", async () => {
    await harness.dispose()
    harness = await createHarness([], { git: false, daemon: "lazy", appChannel: "stable" })
    await expect(harness.caller.alphaTesting.clearProjects()).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(harness.caller.alphaTesting.resetPreferences()).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })
})
