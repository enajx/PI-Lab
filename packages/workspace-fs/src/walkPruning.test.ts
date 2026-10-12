import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"

const reads = vi.hoisted(() => [] as string[])
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      reads.push(String(args[0]))
      return actual.readdir(...args)
    },
  }
})

import { walkWorkspace } from "./walk"

let root: string

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  reads.length = 0
})

test("reads only eligible directories, including scientific outputs", async () => {
  root = await mkdtemp(join(tmpdir(), "pi-lab-pruning-"))
  for (const name of [".venv", "node_modules", ".git", "build", "out", "dist"]) {
    await mkdir(join(root, name))
    await writeFile(join(root, name, "artifact.npy"), "")
  }
  const found: string[] = []
  await walkWorkspace(root, {}, (entry) => {
    if (entry.kind === "file") found.push(entry.path)
    return "continue"
  })
  expect(reads).toEqual([root, join(root, "build"), join(root, "dist"), join(root, "out")])
  expect(found).toHaveLength(3)
})
