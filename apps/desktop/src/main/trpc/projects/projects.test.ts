// Integration tests for the projects router via createCallerFactory over a temp
// SQLite DB with real migrations and a real temp git repo (AGENTS.md §14).
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TRPCError } from "@trpc/server"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createHarness, type Harness } from "../testHarness"

let h: Harness

beforeEach(async () => {
  h = await createHarness()
})

afterEach(async () => {
  await h.dispose()
})

describe("projects.open", () => {
  test("opening a git repo stores name + default branch", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    expect(project.name).toBe("repo")
    expect(project.defaultBranch).toBe("main")
    expect(project.repoPath).toBe(h.repoDir)
  })

  test("a non-git directory is a clean BAD_REQUEST", async () => {
    const plain = await mkdtemp(join(tmpdir(), "skipper-plain-"))
    await expect(h.caller.projects.open({ path: plain })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
  })

  test("re-opening the same repo updates rather than duplicates", async () => {
    const first = await h.caller.projects.open({ path: h.repoDir })
    const again = await h.caller.projects.open({ path: h.repoDir })
    expect(again.id).toBe(first.id)
    const all = await h.caller.projects.list()
    expect(all).toHaveLength(1)
  })
})

describe("projects.list / get / touch / remove", () => {
  test("list returns opened projects", async () => {
    await h.caller.projects.open({ path: h.repoDir })
    const all = await h.caller.projects.list()
    expect(all.map((p) => p.repoPath)).toContain(h.repoDir)
  })

  test("get throws NOT_FOUND for an unknown id", async () => {
    await expect(h.caller.projects.get({ id: "missing" })).rejects.toBeInstanceOf(TRPCError)
  })

  test("touch bumps lastOpenedAt", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const touched = await h.caller.projects.touch({ id: project.id })
    expect(touched.lastOpenedAt).toBeGreaterThanOrEqual(project.lastOpenedAt)
  })

  test("remove forgets the project", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await h.caller.projects.remove({ id: project.id })
    expect(await h.caller.projects.list()).toHaveLength(0)
  })
})

describe("projects.setThumbnail", () => {
  const DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA="

  test("persists a data-URL thumbnail and surfaces it in list/get", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    expect(project.thumbnail).toBeNull()

    const updated = await h.caller.projects.setThumbnail({ id: project.id, dataUrl: DATA_URL })
    expect(updated.thumbnail).toBe(DATA_URL)

    expect((await h.caller.projects.get({ id: project.id })).thumbnail).toBe(DATA_URL)
    const listed = (await h.caller.projects.list()).find((p) => p.id === project.id)
    expect(listed?.thumbnail).toBe(DATA_URL)
  })

  test("clears the thumbnail with dataUrl: null", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await h.caller.projects.setThumbnail({ id: project.id, dataUrl: DATA_URL })

    const cleared = await h.caller.projects.setThumbnail({ id: project.id, dataUrl: null })
    expect(cleared.thumbnail).toBeNull()
    expect((await h.caller.projects.get({ id: project.id })).thumbnail).toBeNull()
  })

  test("rejects a non-data URL", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await expect(
      h.caller.projects.setThumbnail({ id: project.id, dataUrl: "https://example.com/x.png" }),
    ).rejects.toBeInstanceOf(TRPCError)
  })

  test("throws NOT_FOUND for an unknown project", async () => {
    await expect(
      h.caller.projects.setThumbnail({ id: "missing", dataUrl: DATA_URL }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})
