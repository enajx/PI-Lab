// Integration tests for the file tree's manage operations: `trash`, `rename`,
// `duplicate`, and `copyPath`, exercised via createCaller over a temp SQLite DB
// with real migrations and a real temp git repo. The Electron Trash and clipboard
// adapters are injected fakes (labelled below); the filesystem work is real.
import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createHarness, type Harness } from "../testHarness"

let h: Harness
let projectId: string
// Fake adapters standing in for Electron `shell.trashItem` and `clipboard.writeText`.
const trashPath = vi.fn(async (_path: string) => {})
const writeClipboard = vi.fn((_text: string) => {})

beforeEach(async () => {
  trashPath.mockClear()
  writeClipboard.mockClear()
  h = await createHarness(undefined, { trashPath, writeClipboard })
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
    name: "Manage",
    branch: "feature/manage",
  })
  return { id: workspace.id, dir: worktree?.path ?? "" }
}

describe("files.trash", () => {
  test("hands an existing file or folder inside the workspace to the Trash adapter", async () => {
    const ws = await makeWorkspace()
    await writeFile(join(ws.dir, "old.txt"), "old")
    await mkdir(join(ws.dir, "folder"))

    await h.caller.files.trash({ workspaceId: ws.id, relPath: "old.txt" })
    await h.caller.files.trash({ workspaceId: ws.id, relPath: "folder" })

    expect(trashPath.mock.calls.map(([path]) => path)).toEqual([
      join(ws.dir, "old.txt"),
      join(ws.dir, "folder"),
    ])
  })

  test("rejects escapes, the root itself, symlinked parents, and missing paths", async () => {
    const ws = await makeWorkspace()
    const outside = await mkdtemp(join(tmpdir(), "pi-lab-trash-outside-"))
    await writeFile(join(outside, "victim.txt"), "keep")
    await symlink(outside, join(ws.dir, "outside-link"))

    await expect(
      h.caller.files.trash({ workspaceId: ws.id, relPath: "../outside.txt" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      h.caller.files.trash({ workspaceId: ws.id, relPath: join(outside, "victim.txt") }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(h.caller.files.trash({ workspaceId: ws.id, relPath: "." })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(
      h.caller.files.trash({ workspaceId: ws.id, relPath: "outside-link/victim.txt" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      h.caller.files.trash({ workspaceId: ws.id, relPath: "missing.txt" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(trashPath).not.toHaveBeenCalled()
  })

  test("trashes a symlink itself, never the outside target it points to", async () => {
    const ws = await makeWorkspace()
    const outside = await mkdtemp(join(tmpdir(), "pi-lab-trash-link-"))
    await symlink(outside, join(ws.dir, "outside-link"))

    await h.caller.files.trash({ workspaceId: ws.id, relPath: "outside-link" })
    expect(trashPath).toHaveBeenCalledWith(join(ws.dir, "outside-link"))
  })
})

describe("files.rename", () => {
  test("renames a file and a folder inside the workspace", async () => {
    const ws = await makeWorkspace()
    await mkdir(join(ws.dir, "notes"))
    await writeFile(join(ws.dir, "notes", "a.md"), "alpha")

    const file = await h.caller.files.rename({
      workspaceId: ws.id,
      relPath: "notes/a.md",
      newRelPath: "notes/b.md",
    })
    expect(file).toEqual({ relPath: "notes/b.md" })
    expect(await readFile(join(ws.dir, "notes", "b.md"), "utf8")).toBe("alpha")

    const folder = await h.caller.files.rename({
      workspaceId: ws.id,
      relPath: "notes",
      newRelPath: "docs",
    })
    expect(folder).toEqual({ relPath: "docs" })
    expect(await readFile(join(ws.dir, "docs", "b.md"), "utf8")).toBe("alpha")
  })

  test("allows a case-only rename of the same file", async () => {
    const ws = await makeWorkspace()
    await writeFile(join(ws.dir, "readme.txt"), "x")
    await h.caller.files.rename({
      workspaceId: ws.id,
      relPath: "readme.txt",
      newRelPath: "README.txt",
    })
    expect(await readFile(join(ws.dir, "README.txt"), "utf8")).toBe("x")
  })

  test("refuses to overwrite, to escape the workspace, or to rename a missing path", async () => {
    const ws = await makeWorkspace()
    const outside = await mkdtemp(join(tmpdir(), "pi-lab-rename-outside-"))
    await symlink(outside, join(ws.dir, "outside-link"))
    await writeFile(join(ws.dir, "a.txt"), "a")
    await writeFile(join(ws.dir, "b.txt"), "b")

    await expect(
      h.caller.files.rename({ workspaceId: ws.id, relPath: "a.txt", newRelPath: "b.txt" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await readFile(join(ws.dir, "b.txt"), "utf8")).toBe("b")
    await expect(
      h.caller.files.rename({ workspaceId: ws.id, relPath: "a.txt", newRelPath: "../a.txt" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      h.caller.files.rename({
        workspaceId: ws.id,
        relPath: "a.txt",
        newRelPath: "outside-link/a.txt",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      h.caller.files.rename({ workspaceId: ws.id, relPath: "nope.txt", newRelPath: "c.txt" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(await readFile(join(ws.dir, "a.txt"), "utf8")).toBe("a")
  })
})

describe("files.duplicate", () => {
  test("copies a file next to itself with a Finder-style unique name", async () => {
    const ws = await makeWorkspace()
    await mkdir(join(ws.dir, "src"))
    await writeFile(join(ws.dir, "src", "main.py"), "print(1)\n")

    const first = await h.caller.files.duplicate({ workspaceId: ws.id, relPath: "src/main.py" })
    const second = await h.caller.files.duplicate({ workspaceId: ws.id, relPath: "src/main.py" })

    expect(first).toEqual({ relPath: "src/main copy.py" })
    expect(second).toEqual({ relPath: "src/main copy 2.py" })
    expect(await readFile(join(ws.dir, "src", "main copy 2.py"), "utf8")).toBe("print(1)\n")
  })

  test("keeps dotfile names whole and refuses folders and escapes", async () => {
    const ws = await makeWorkspace()
    await writeFile(join(ws.dir, ".env"), "A=1")
    await mkdir(join(ws.dir, "folder"))

    expect(await h.caller.files.duplicate({ workspaceId: ws.id, relPath: ".env" })).toEqual({
      relPath: ".env copy",
    })
    await expect(
      h.caller.files.duplicate({ workspaceId: ws.id, relPath: "folder" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(
      h.caller.files.duplicate({ workspaceId: ws.id, relPath: "../x.txt" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect((await lstat(join(ws.dir, "folder"))).isDirectory()).toBe(true)
  })
})

describe("files.copyPath", () => {
  test("writes the absolute or the workspace-relative path to the clipboard adapter", async () => {
    const ws = await makeWorkspace()
    await mkdir(join(ws.dir, "notes"))
    await writeFile(join(ws.dir, "notes", "a.md"), "")

    await h.caller.files.copyPath({ workspaceId: ws.id, relPath: "notes/a.md", form: "absolute" })
    await h.caller.files.copyPath({ workspaceId: ws.id, relPath: "notes/a.md", form: "relative" })

    expect(writeClipboard.mock.calls.map(([text]) => text)).toEqual([
      join(await realpath(ws.dir), "notes", "a.md"),
      "notes/a.md",
    ])
    await expect(
      h.caller.files.copyPath({ workspaceId: ws.id, relPath: "../x", form: "absolute" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})
