// Integration tests for the files router (docs/testing-and-build.md): createCaller over a
// temp SQLite DB with real migrations + a real temp git repo. They prove the
// read/write round-trip inside a workspace's working dir and that a path
// escaping that dir (`../outside`) is rejected. Plus a pure unit on the jailing
// helper so the guard's edge cases don't need disk.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createHarness, type Harness } from "../testHarness"
import { resolveInsideDir } from "./files"

let h: Harness
let projectId: string

beforeEach(async () => {
  h = await createHarness()
  const project = await h.caller.projects.open({ path: h.repoDir })
  projectId = project.id
})

afterEach(async () => {
  await h.dispose()
})

/** Create a worktree workspace and return its id + on-disk working dir. */
async function makeWorkspace(): Promise<{ id: string; dir: string }> {
  const { workspace, worktree } = await h.caller.workspaces.create({
    projectId,
    kind: "worktree",
    name: "Docs",
    branch: "feature/docs",
  })
  return { id: workspace.id, dir: worktree?.path ?? "" }
}

describe("files.read / files.write round-trip", () => {
  test("write then read returns the same content from inside the working dir", async () => {
    const ws = await makeWorkspace()

    const written = await h.caller.files.write({
      workspaceId: ws.id,
      relPath: "RESEARCH.md",
      content: "# Research\n\nfindings\n",
    })
    expect(written.bytes).toBeGreaterThan(0)

    const result = await h.caller.files.read({ workspaceId: ws.id, relPath: "RESEARCH.md" })
    expect(result.exists).toBe(true)
    expect(result.content).toBe("# Research\n\nfindings\n")

    // The file really landed on disk inside the worktree, not elsewhere.
    expect(await readFile(join(ws.dir, "RESEARCH.md"), "utf8")).toBe("# Research\n\nfindings\n")
  })

  test("write creates missing parent directories", async () => {
    const ws = await makeWorkspace()
    await h.caller.files.write({
      workspaceId: ws.id,
      relPath: "notes/deep/todo.md",
      content: "- [ ] task\n",
    })
    const result = await h.caller.files.read({ workspaceId: ws.id, relPath: "notes/deep/todo.md" })
    expect(result.content).toBe("- [ ] task\n")
  })

  test("reading a file that already exists on disk works", async () => {
    const ws = await makeWorkspace()
    await writeFile(join(ws.dir, "TODO.md"), "- [x] done\n")
    const result = await h.caller.files.read({ workspaceId: ws.id, relPath: "TODO.md" })
    expect(result.exists).toBe(true)
    expect(result.content).toBe("- [x] done\n")
  })

  test("reading a missing file yields exists:false, not an error", async () => {
    const ws = await makeWorkspace()
    const result = await h.caller.files.read({ workspaceId: ws.id, relPath: "RESEARCH.md" })
    expect(result.exists).toBe(false)
    expect(result.content).toBe("")
  })
})

describe("files path-traversal guard", () => {
  test("a relative path escaping the working dir is rejected (read)", async () => {
    const ws = await makeWorkspace()
    // Plant a secret one level above the worktree so a successful escape would
    // be observable; the guard must reject before any read happens.
    await mkdir(join(ws.dir, ".."), { recursive: true })
    await writeFile(join(ws.dir, "..", "outside.txt"), "secret\n")

    await expect(
      h.caller.files.read({ workspaceId: ws.id, relPath: "../outside.txt" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  test("a relative path escaping the working dir is rejected (write)", async () => {
    const ws = await makeWorkspace()
    await expect(
      h.caller.files.write({
        workspaceId: ws.id,
        relPath: "../escape.txt",
        content: "nope",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  test("an absolute path is rejected", async () => {
    const ws = await makeWorkspace()
    await expect(
      h.caller.files.read({ workspaceId: ws.id, relPath: "/etc/hosts" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  test("an unknown workspace id is NOT_FOUND", async () => {
    await expect(
      h.caller.files.read({ workspaceId: "ghost", relPath: "RESEARCH.md" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("resolveInsideDir (pure)", () => {
  const base = "/work/repo"

  test("resolves a simple relative path under the base", () => {
    expect(resolveInsideDir(base, "RESEARCH.md")).toBe("/work/repo/RESEARCH.md")
  })

  test("resolves a nested relative path", () => {
    expect(resolveInsideDir(base, "a/b/c.md")).toBe("/work/repo/a/b/c.md")
  })

  test("collapses interior .. that stays inside", () => {
    expect(resolveInsideDir(base, "a/../RESEARCH.md")).toBe("/work/repo/RESEARCH.md")
  })

  test("rejects a leading .. escape", () => {
    expect(() => resolveInsideDir(base, "../outside")).toThrow(/escapes/)
  })

  test("rejects deep .. escapes", () => {
    expect(() => resolveInsideDir(base, "a/../../outside")).toThrow(/escapes/)
  })

  test("rejects an absolute path", () => {
    expect(() => resolveInsideDir(base, "/etc/passwd")).toThrow(/relative/)
  })
})
