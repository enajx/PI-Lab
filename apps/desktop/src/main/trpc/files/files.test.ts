// Integration tests for the files router (md/engineering/testing-and-build.md): createCaller over a
// temp SQLite DB with real migrations + a real temp git repo. They prove the
// read/write round-trip inside a workspace's working dir and that a path
// escaping that dir (`../outside`) is rejected. Plus a pure unit on the jailing
// helper so the guard's edge cases don't need disk.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as workspaceFs from "@pi-lab/workspace-fs"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createHarness, type Harness } from "../testHarness"
import { resolveInsideDir } from "./files"

let h: Harness
let projectId: string
const revealPath = vi.fn()

beforeEach(async () => {
  revealPath.mockReset()
  h = await createHarness(undefined, { revealPath })
  const project = await h.caller.projects.open({ path: h.repoDir })
  projectId = project.id
})

afterEach(async () => {
  vi.restoreAllMocks()
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
    expect("content" in result ? result.content : undefined).toBe("# Research\n\nfindings\n")

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
    expect("content" in result ? result.content : undefined).toBe("- [ ] task\n")
  })

  test("reading a file that already exists on disk works", async () => {
    const ws = await makeWorkspace()
    await writeFile(join(ws.dir, "TODO.md"), "- [x] done\n")
    const result = await h.caller.files.read({ workspaceId: ws.id, relPath: "TODO.md" })
    expect(result.exists).toBe(true)
    expect("content" in result ? result.content : undefined).toBe("- [x] done\n")
  })

  test("reading a missing file yields exists:false, not an error", async () => {
    const ws = await makeWorkspace()
    const result = await h.caller.files.read({ workspaceId: ws.id, relPath: "RESEARCH.md" })
    expect(result.exists).toBe(false)
    expect("content" in result ? result.content : undefined).toBe("")
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

test("read and post-write verification return text with its own disk fingerprint", async () => {
  const ws = await makeWorkspace()
  const content = "paired UTF-8 text: π\n"
  const written = await h.caller.files.write({ workspaceId: ws.id, relPath: "paired.txt", content })
  const actual = await stat(join(ws.dir, "paired.txt"))
  expect(written).toMatchObject({
    bytes: Buffer.byteLength(content),
    baseline: { mtimeMs: actual.mtimeMs, size: actual.size },
    matchesWrittenContent: true,
  })
  const read = await h.caller.files.read({ workspaceId: ws.id, relPath: "paired.txt" })
  expect(read).toMatchObject({ content, baseline: { mtimeMs: actual.mtimeMs, size: actual.size } })
})

test("post-write verification reports a real external replacement (injected timing)", async () => {
  const ws = await makeWorkspace()
  const write = workspaceFs.writeTextFile
  vi.spyOn(workspaceFs, "writeTextFile").mockImplementationOnce(async (path, content) => {
    await write(path, content)
    await writeFile(path, "external replacement")
  })
  const result = await h.caller.files.write({
    workspaceId: ws.id,
    relPath: "paired.txt",
    content: "local",
  })
  expect(result.matchesWrittenContent).toBe(false)
  const current = await stat(join(ws.dir, "paired.txt"))
  expect(result.baseline).toEqual({ exists: true, mtimeMs: current.mtimeMs, size: current.size })
  expect(await readFile(join(ws.dir, "paired.txt"), "utf8")).toBe("external replacement")
})

test("bounded router reads reject oversize/binary contents and still verify saves above 10 MB", async () => {
  const ws = await makeWorkspace()
  const content = `${"x".repeat(10_000_000)}😀`
  const written = await h.caller.files.write({ workspaceId: ws.id, relPath: "large.txt", content })
  expect(written.matchesWrittenContent).toBe(true)
  expect(written).not.toHaveProperty("content")
  expect(written.baseline.size).toBe(10_000_004)
  const read = await h.caller.files.read({ workspaceId: ws.id, relPath: "large.txt" })
  expect(read).toMatchObject({ status: "oversized", size: 10_000_004 })
  expect(read).not.toHaveProperty("content")
  await writeFile(join(ws.dir, "binary.txt"), Buffer.from([0xff, 65]))
  const binary = await h.caller.files.read({ workspaceId: ws.id, relPath: "binary.txt" })
  expect(binary).toMatchObject({ status: "binary", size: 2 })
  expect(binary).not.toHaveProperty("content")
})

test("Reveal in Finder passes jailed real files to the adapter and rejects symlink escapes", async () => {
  const { symlink, realpath } = await import("node:fs/promises")
  const ws = await makeWorkspace()
  await writeFile(join(ws.dir, "local.txt"), "local")
  const reveal = revealPath
  await h.caller.files.reveal({ workspaceId: ws.id, relPath: "local.txt" })
  expect(reveal).toHaveBeenCalledWith(await realpath(join(ws.dir, "local.txt")))
  await expect(
    h.caller.files.reveal({ workspaceId: ws.id, relPath: "../outside" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" })
  await writeFile(join(h.repoDir, "outside.txt"), "outside")
  await symlink(join(h.repoDir, "outside.txt"), join(ws.dir, "escape.txt"))
  await expect(
    h.caller.files.reveal({ workspaceId: ws.id, relPath: "escape.txt" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" })
  expect(reveal).toHaveBeenCalledTimes(1)
})
