import { mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { QuickEditFiles } from "./service"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test("a registered file opens as text and saves against its baseline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-quick-edit-"))
  dirs.push(dir)
  const path = join(dir, "main.py")
  await writeFile(path, "print(1)\n")
  const files = new QuickEditFiles()
  const target = files.register(path)
  const snapshot = await files.read(target.id)
  expect(snapshot.status).toBe("text")
  const result = await files.save(target.id, "print(2)\n", snapshot.baseline, false)
  expect(result.status).toBe("saved")
  expect(await readFile(path, "utf8")).toBe("print(2)\n")
})

test("an outside edit causes a conflict until explicit overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-quick-edit-"))
  dirs.push(dir)
  const path = join(dir, "main.cpp")
  await writeFile(path, "one")
  const files = new QuickEditFiles()
  const target = files.register(path)
  const snapshot = await files.read(target.id)
  await writeFile(path, "external change")
  expect(await files.save(target.id, "mine", snapshot.baseline, false)).toMatchObject({
    status: "conflict",
  })
  expect(await readFile(path, "utf8")).toBe("external change")
  expect(await files.save(target.id, "mine", snapshot.baseline, true)).toMatchObject({
    status: "saved",
  })
  expect(await readFile(path, "utf8")).toBe("mine")
})

test("an equal-size edit with restored mtime still conflicts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-quick-edit-"))
  dirs.push(dir)
  const path = join(dir, "main.py")
  await writeFile(path, "one")
  const files = new QuickEditFiles()
  const target = files.register(path)
  const snapshot = await files.read(target.id)
  await writeFile(path, "two")
  await utimes(path, snapshot.baseline.mtimeMs / 1000, snapshot.baseline.mtimeMs / 1000)
  expect(await files.save(target.id, "mine", snapshot.baseline, false)).toMatchObject({
    status: "conflict",
  })
  expect(await readFile(path, "utf8")).toBe("two")
})

test("unregistered ids cannot access disk", async () => {
  const files = new QuickEditFiles()
  await expect(files.read("/etc/passwd")).rejects.toThrow("Unknown quick-edit file")
})

test("does not follow a replacement symlink, even for explicit overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-quick-edit-"))
  dirs.push(dir)
  const path = join(dir, "main.py")
  const outside = join(dir, "outside.py")
  await writeFile(path, "original")
  await writeFile(outside, "outside")
  const files = new QuickEditFiles()
  const target = files.register(path)
  const snapshot = await files.read(target.id)
  await rename(path, join(dir, "old.py"))
  await symlink(outside, path)
  await expect(files.save(target.id, "mine", snapshot.baseline, true)).rejects.toThrow(
    "regular file",
  )
  expect(await readFile(outside, "utf8")).toBe("outside")
})

test("opens an initial symlink and saves its original resolved target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-quick-edit-"))
  dirs.push(dir)
  const targetPath = join(dir, "actual.py")
  const linkPath = join(dir, "main.py")
  await writeFile(targetPath, "before")
  await symlink(targetPath, linkPath)
  const files = new QuickEditFiles()
  const target = files.register(linkPath)
  const snapshot = await files.read(target.id)
  await files.save(target.id, "after", snapshot.baseline, false)
  expect(await readFile(targetPath, "utf8")).toBe("after")
})

test("can save text that grows beyond the bounded opening size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-quick-edit-"))
  dirs.push(dir)
  const path = join(dir, "long.txt")
  await writeFile(path, "short")
  const files = new QuickEditFiles()
  const target = files.register(path)
  const snapshot = await files.read(target.id)
  const content = "x".repeat(10_000_001)
  expect(await files.save(target.id, content, snapshot.baseline, false)).toMatchObject({
    status: "saved",
  })
})

test("Save As creates a new file and verifies its contents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-quick-edit-"))
  dirs.push(dir)
  const path = join(dir, "new.py")
  const files = new QuickEditFiles()
  expect(await files.saveUntitled(path, "print('new')\n")).toBe(path)
  expect(await readFile(path, "utf8")).toBe("print('new')\n")
})

test("Save As can replace an existing regular file after the native dialog accepts it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-quick-edit-"))
  dirs.push(dir)
  const path = join(dir, "notes.txt")
  await writeFile(path, "before")
  const files = new QuickEditFiles()
  expect(await files.saveUntitled(path, "after")).toBe(path)
  expect(await readFile(path, "utf8")).toBe("after")
})

test("Save As refuses symlinks instead of following them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-quick-edit-"))
  dirs.push(dir)
  const path = join(dir, "notes.txt")
  const outside = join(dir, "outside.txt")
  await writeFile(outside, "safe")
  await symlink(outside, path)
  const files = new QuickEditFiles()
  await expect(files.saveUntitled(path, "changed")).rejects.toThrow("regular file")
  expect(await readFile(outside, "utf8")).toBe("safe")
})
