// Integration tests for the files router's editor primitives (md/engineering/testing-and-build.md):
// `stat`, `tree`, and `search`, exercised via createCaller over a temp SQLite DB
// with real migrations and a real temp git repo. These prove the file tree, the
// quick-open fuzzy search, and the external-change fingerprint the built-in
// editor relies on, including that all three honor the path-traversal jail.
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createHarness, type Harness } from "../testHarness"

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
    name: "Edit",
    branch: "feature/edit",
  })
  return { id: workspace.id, dir: worktree?.path ?? "" }
}

describe("files.stat", () => {
  test("reports a real file's size and a positive mtime", async () => {
    const ws = await makeWorkspace()
    await h.caller.files.write({ workspaceId: ws.id, relPath: "main.py", content: "x = 1\n" })

    const stat = await h.caller.files.stat({ workspaceId: ws.id, relPath: "main.py" })
    expect(stat.exists).toBe(true)
    expect(stat.size).toBe(6)
    expect(stat.mtimeMs).toBeGreaterThan(0)
  })

  test("changes its fingerprint after an out-of-band edit", async () => {
    const ws = await makeWorkspace()
    await h.caller.files.write({ workspaceId: ws.id, relPath: "main.py", content: "x = 1\n" })
    const before = await h.caller.files.stat({ workspaceId: ws.id, relPath: "main.py" })

    // Simulate an agent/git edit straight on disk.
    await writeFile(join(ws.dir, "main.py"), "x = 1\ny = 2\n")
    const after = await h.caller.files.stat({ workspaceId: ws.id, relPath: "main.py" })

    expect(after.exists).toBe(true)
    expect(after.size).not.toBe(before.size)
  })

  test("a missing file reports exists:false", async () => {
    const ws = await makeWorkspace()
    const stat = await h.caller.files.stat({ workspaceId: ws.id, relPath: "ghost.py" })
    expect(stat).toEqual({ exists: false, mtimeMs: 0, size: 0 })
  })

  test("rejects a traversal escape", async () => {
    const ws = await makeWorkspace()
    await expect(
      h.caller.files.stat({ workspaceId: ws.id, relPath: "../outside" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})

describe("files.tree", () => {
  test("lists the root with directories first, then files, by name", async () => {
    const ws = await makeWorkspace()
    await h.caller.files.write({ workspaceId: ws.id, relPath: "src/app.py", content: "" })
    await h.caller.files.write({ workspaceId: ws.id, relPath: "z.py", content: "" })
    await h.caller.files.write({ workspaceId: ws.id, relPath: "a.py", content: "" })

    const entries = await h.caller.files.tree({ workspaceId: ws.id, relPath: "" })
    const names = entries.map((e) => e.name)
    // The worktree already has README.md from the fixture; src/ (dir) sorts first.
    expect(names[0]).toBe("src")
    expect(entries.find((e) => e.name === "src")?.kind).toBe("dir")
    // Files appear after the dir, alphabetically.
    const fileNames = entries.filter((e) => e.kind === "file").map((e) => e.name)
    expect(fileNames).toEqual([...fileNames].sort((a, b) => a.localeCompare(b)))
    expect(fileNames).toContain("a.py")
    expect(fileNames).toContain("z.py")
  })

  test("lists a child directory and returns workspace-relative POSIX paths", async () => {
    const ws = await makeWorkspace()
    await h.caller.files.write({ workspaceId: ws.id, relPath: "src/lib/util.py", content: "" })

    const child = await h.caller.files.tree({ workspaceId: ws.id, relPath: "src" })
    expect(child).toEqual([
      {
        name: "lib",
        relPath: "src/lib",
        kind: "dir",
        type: "folder",
        mtimeMs: expect.any(Number),
      },
    ])
  })

  test("omits .git and node_modules noise", async () => {
    const ws = await makeWorkspace()
    await mkdir(join(ws.dir, "node_modules", "pkg"), { recursive: true })
    await writeFile(join(ws.dir, "node_modules", "pkg", "index.js"), "")

    const entries = await h.caller.files.tree({ workspaceId: ws.id, relPath: "" })
    const names = entries.map((e) => e.name)
    expect(names).not.toContain(".git")
    expect(names).not.toContain("node_modules")
  })

  test("rejects a traversal escape", async () => {
    const ws = await makeWorkspace()
    await expect(
      h.caller.files.tree({ workspaceId: ws.id, relPath: "../.." }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})

describe("files.createFile / createFolder", () => {
  test("creates an empty folder and file and exposes sortable metadata", async () => {
    const ws = await makeWorkspace()

    await h.caller.files.createFolder({ workspaceId: ws.id, relPath: "notes" })
    const created = await h.caller.files.createFile({
      workspaceId: ws.id,
      relPath: "notes/idea.MD",
    })

    expect(created).toEqual({ relPath: "notes/idea.MD" })
    expect(await readFile(join(ws.dir, "notes", "idea.MD"), "utf8")).toBe("")
    expect((await stat(join(ws.dir, "notes"))).isDirectory()).toBe(true)
    expect(await h.caller.files.tree({ workspaceId: ws.id, relPath: "notes" })).toEqual([
      {
        name: "idea.MD",
        relPath: "notes/idea.MD",
        kind: "file",
        type: "md",
        mtimeMs: expect.any(Number),
      },
    ])
  })

  test("rejects duplicate entries without overwriting them", async () => {
    const ws = await makeWorkspace()
    await h.caller.files.createFolder({ workspaceId: ws.id, relPath: "notes" })
    await h.caller.files.createFile({ workspaceId: ws.id, relPath: "notes/idea.md" })

    await expect(
      h.caller.files.createFolder({ workspaceId: ws.id, relPath: "notes" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(
      h.caller.files.createFile({ workspaceId: ws.id, relPath: "notes/idea.md" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await readFile(join(ws.dir, "notes", "idea.md"), "utf8")).toBe("")
  })

  test("rejects traversal, absolute paths, missing parents, and symlink-parent escapes", async () => {
    const ws = await makeWorkspace()
    const outside = await mkdtemp(join(tmpdir(), "pi-lab-create-outside-"))
    await symlink(outside, join(ws.dir, "outside-link"))

    await expect(
      h.caller.files.createFile({ workspaceId: ws.id, relPath: "../escaped.md" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      h.caller.files.createFolder({ workspaceId: ws.id, relPath: join(outside, "absolute") }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      h.caller.files.createFile({ workspaceId: ws.id, relPath: "missing/child.md" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(
      h.caller.files.createFile({ workspaceId: ws.id, relPath: "outside-link/escaped.md" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})

describe("files.search", () => {
  test("fuzzy-matches file names and returns relative POSIX paths", async () => {
    const ws = await makeWorkspace()
    await h.caller.files.write({ workspaceId: ws.id, relPath: "src/analysis.py", content: "" })
    await h.caller.files.write({ workspaceId: ws.id, relPath: "src/plot.py", content: "" })
    await h.caller.files.write({ workspaceId: ws.id, relPath: "docs/notes.md", content: "" })

    const hits = await h.caller.files.search({ workspaceId: ws.id, query: "analy" })
    const paths = hits.map((hit) => hit.relPath)
    expect(paths).toContain("src/analysis.py")
    expect(paths).not.toContain("docs/notes.md")
    expect(hits.every((hit) => hit.score > 0)).toBe(true)
  })

  test("an empty query returns no hits", async () => {
    const ws = await makeWorkspace()
    await h.caller.files.write({ workspaceId: ws.id, relPath: "main.py", content: "" })
    const hits = await h.caller.files.search({ workspaceId: ws.id, query: "  " })
    expect(hits).toEqual([])
  })

  test("respects the result limit", async () => {
    const ws = await makeWorkspace()
    for (let i = 0; i < 5; i++) {
      await h.caller.files.write({ workspaceId: ws.id, relPath: `note${i}.py`, content: "" })
    }
    const hits = await h.caller.files.search({ workspaceId: ws.id, query: "note", limit: 2 })
    expect(hits.length).toBe(2)
  })
})
