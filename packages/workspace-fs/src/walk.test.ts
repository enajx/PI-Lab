import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { walkWorkspace } from "./walk"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-lab-walk-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("walkWorkspace", () => {
  test("prunes common noise without pruning scientific output", async () => {
    for (const dir of [".venv", "node_modules", ".git", "build", "out", "dist"]) {
      await mkdir(join(root, dir))
      await writeFile(join(root, dir, "sample.npy"), "")
    }
    const visited: string[] = []
    const result = await walkWorkspace(root, {}, (entry) => {
      if (entry.kind === "file") visited.push(entry.path)
      return "continue" as const
    })
    expect(visited).toEqual(["build", "dist", "out"].map((dir) => join(root, dir, "sample.npy")))
    expect(result).toEqual({ stopped: false, partial: false, skipped: [] })
  })

  test("lets a visitor capture a directory and prune its children", async () => {
    await mkdir(join(root, "sample.zarr"))
    await writeFile(join(root, "sample.zarr", "chunk"), "")
    const visited: string[] = []
    await walkWorkspace(root, {}, (entry) => {
      visited.push(entry.path)
      return entry.name === "sample.zarr" ? "prune" : "continue"
    })
    expect(visited).toEqual([join(root, "sample.zarr")])
  })

  test("surfaces a vanished child as a partial result", async () => {
    await mkdir(join(root, "a"))
    await mkdir(join(root, "b"))
    const result = await walkWorkspace(root, {}, async (entry) => {
      if (entry.name === "a") await rm(join(root, "b"), { recursive: true })
      return "continue" as const
    })
    expect(result).toEqual({ stopped: false, partial: true, skipped: ["b"] })
  })

  test("throws when the root is unreadable or missing", async () => {
    await expect(walkWorkspace(join(root, "missing"), {}, () => "continue")).rejects.toThrow()
  })

  test.each(["EACCES", "EPERM", "ENOENT"])("records expected visitor %s errors", async (code) => {
    await writeFile(join(root, "sample.npy"), "")
    const denied = Object.assign(new Error("unavailable"), { code })
    const partial = await walkWorkspace(root, {}, () => {
      throw denied
    })
    expect(partial).toEqual({ stopped: false, partial: true, skipped: ["sample.npy"] })
  })

  test("throws unexpected visitor I/O failures", async () => {
    await writeFile(join(root, "sample.npy"), "")
    const broken = Object.assign(new Error("disk failed"), { code: "EIO" })
    await expect(
      walkWorkspace(root, {}, () => {
        throw broken
      }),
    ).rejects.toBe(broken)
  })
})
