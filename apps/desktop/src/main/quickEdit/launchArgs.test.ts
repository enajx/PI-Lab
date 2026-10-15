import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { firstFileArgument } from "./launchArgs"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test("skips Electron's main entry and opens the following file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-launch-"))
  dirs.push(dir)
  const entry = join(dir, "out", "main", "index.js")
  const file = join(dir, "scratch.py")
  await (await import("node:fs/promises")).mkdir(join(dir, "out", "main"), {
    recursive: true,
  })
  await writeFile(entry, "entry")
  await writeFile(file, "print(1)")
  expect(firstFileArgument(["/Electron", entry, file], dir, entry)).toBe(file)
  expect(firstFileArgument([entry, file], dir, entry)).toBe(file)
  expect(firstFileArgument(["/Applications/PI Lab", file], dir, entry)).toBe(file)
})
