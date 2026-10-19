import { lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
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

test("Stable's command follows its current repo build after replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-command-"))
  dirs.push(dir)
  const release = join(dir, "release", "stable")
  const bundleName = "PI Lab.app"
  const resourceTail = join(bundleName, "Contents", "Resources", "bin", "pilab")
  const oldScript = join(release, "builds", "old", "mac-arm64", resourceTail)
  const newScript = join(release, "builds", "new", "mac-arm64", resourceTail)
  const aliasBundle = join(release, "mac-arm64", bundleName)
  await mkdir(join(release, "mac-arm64"), { recursive: true })
  for (const script of [oldScript, newScript]) {
    await mkdir(join(script, ".."), { recursive: true })
    await writeFile(script, "#!/bin/sh\n")
  }
  await symlink(join(release, "builds", "old", "mac-arm64", bundleName), aliasBundle)
  const link = await installCommand(dir, oldScript)
  expect(await readlink(link)).toBe(join(aliasBundle, "Contents", "Resources", "bin", "pilab"))
  await rm(aliasBundle)
  await symlink(join(release, "builds", "new", "mac-arm64", bundleName), aliasBundle)
  expect(await realpath(link)).toBe(await realpath(newScript))
  await rm(link)
  await symlink(oldScript, link)
  await installCommand(dir, newScript)
  expect(await readlink(link)).toBe(join(aliasBundle, "Contents", "Resources", "bin", "pilab"))
})
