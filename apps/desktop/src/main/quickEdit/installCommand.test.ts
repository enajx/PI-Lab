import { lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { installCommand } from "./installCommand"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test("installs an idempotent command link into the user's local bin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-command-"))
  dirs.push(dir)
  const script = join(dir, "app", "pilab")
  await mkdir(join(dir, "app"))
  await writeFile(script, "#!/bin/sh\n")
  const link = await installCommand(dir, script)
  expect(link).toBe(join(dir, ".local", "bin", "pilab"))
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
  expect(await readlink(link)).toBe(script)
  expect(await installCommand(dir, script)).toBe(link)
})

test("does not replace an existing user command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-command-"))
  dirs.push(dir)
  const script = join(dir, "app", "pilab")
  await mkdir(join(dir, "app"))
  await writeFile(script, "#!/bin/sh\n")
  const bin = join(dir, ".local", "bin")
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, "pilab"), "user command")
  await expect(installCommand(dir, script)).rejects.toThrow("already exists")
})
