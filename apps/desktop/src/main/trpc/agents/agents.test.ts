import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createHarness, FAKE_AGENT, type Harness } from "../testHarness"

let h: Harness
let projectId: string

beforeEach(async () => {
  h = await createHarness()
  projectId = (await h.caller.projects.open({ path: h.repoDir })).id
})

afterEach(async () => {
  await h.dispose()
})

describe("agents catalog and project choice", () => {
  test("reports availability and remembers an app-memory project choice", async () => {
    expect(await h.caller.agents.list()).toEqual([
      {
        id: FAKE_AGENT.id,
        label: FAKE_AGENT.label,
        available: true,
        executable: process.execPath,
        oneShot: false,
      },
    ])

    expect(await h.caller.agents.projectChoice({ projectId })).toEqual({
      agentId: null,
      storage: "app",
    })
    await h.caller.agents.setProjectChoice({ projectId, agentId: FAKE_AGENT.id })
    expect(await h.caller.agents.projectChoice({ projectId })).toEqual({
      agentId: FAKE_AGENT.id,
      storage: "app",
    })
  })

  test("project-file storage preserves unrelated JSON keys", async () => {
    const path = join(h.repoDir, ".pi-lab", "config.json")
    await h.caller.settings.updateAgents({ projectConfigStorage: "project" })
    await h.caller.agents.setProjectChoice({ projectId, agentId: FAKE_AGENT.id })
    const first = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    expect(first.agentId).toBe(FAKE_AGENT.id)

    await writeFile(path, JSON.stringify({ ...first, userNote: "keep me" }))
    await h.caller.agents.setProjectChoice({ projectId, agentId: FAKE_AGENT.id })
    const updated = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    expect(updated.userNote).toBe("keep me")
  })

  test("both storage treats the repository file as authoritative", async () => {
    const path = join(h.repoDir, ".pi-lab", "config.json")
    await h.caller.agents.setProjectChoice({ projectId, agentId: FAKE_AGENT.id })
    await h.caller.settings.updateAgents({ projectConfigStorage: "both" })
    await h.caller.agents.setProjectChoice({ projectId, agentId: FAKE_AGENT.id })
    await writeFile(path, JSON.stringify({ agentId: "repo-choice" }))

    expect(await h.caller.agents.projectChoice({ projectId })).toEqual({
      agentId: "repo-choice",
      storage: "both",
    })
  })

  test("app-memory storage does not create a repository config", async () => {
    await h.caller.agents.setProjectChoice({ projectId, agentId: FAKE_AGENT.id })
    await expect(access(join(h.repoDir, ".pi-lab", "config.json"))).rejects.toBeTruthy()
  })

  test("rejects a .pi-lab symlink that escapes the repository", async () => {
    const outside = join(h.dataDir, "outside-config")
    await mkdir(outside)
    await writeFile(join(outside, "config.json"), JSON.stringify({ userNote: "outside" }))
    await symlink(outside, join(h.repoDir, ".pi-lab"))
    await h.caller.settings.updateAgents({ projectConfigStorage: "project" })

    await expect(
      h.caller.agents.setProjectChoice({ projectId, agentId: FAKE_AGENT.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(JSON.parse(await readFile(join(outside, "config.json"), "utf8"))).toEqual({
      userNote: "outside",
    })
  })

  test("an invalid executable override is unavailable and launch fails clearly", async () => {
    await h.caller.settings.updateAgents({
      executableOverrides: { [FAKE_AGENT.id]: "/missing/pi-lab-agent" },
    })
    expect((await h.caller.agents.list())[0]).toMatchObject({
      id: FAKE_AGENT.id,
      available: false,
      executable: "/missing/pi-lab-agent",
    })
    await expect(
      h.caller.sessions.start({ projectId, agentId: FAKE_AGENT.id }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("not available"),
    })
    expect(await h.caller.workspaces.list({ projectId })).toEqual([])
  })
})

test.each([
  "app",
  "project",
  "both",
] as const)("clears the project agent in %s storage", async (storage) => {
  await h.caller.settings.updateAgents({ projectConfigStorage: storage })
  await h.caller.agents.setProjectChoice({ projectId, agentId: FAKE_AGENT.id })
  await h.caller.agents.setProjectChoice({ projectId, agentId: null })
  expect(await h.caller.agents.projectChoice({ projectId })).toEqual({ agentId: null, storage })
})
