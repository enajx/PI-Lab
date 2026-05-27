import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { listDir, readTextFile, walkFiles } from "./fs"

let root: string

/**
 * Build a small workspace tree:
 *
 *   root/
 *     README.md
 *     src/
 *       index.ts
 *       util/helpers.ts
 *     .git/HEAD           (must be ignored by walkFiles)
 *     node_modules/dep/i.js  (must be ignored by walkFiles)
 */
async function seedTree(base: string): Promise<void> {
  await writeFile(join(base, "README.md"), "# hello\n")
  await mkdir(join(base, "src", "util"), { recursive: true })
  await writeFile(join(base, "src", "index.ts"), "export const x = 1\n")
  await writeFile(join(base, "src", "util", "helpers.ts"), "export const y = 2\n")
  await mkdir(join(base, ".git"), { recursive: true })
  await writeFile(join(base, ".git", "HEAD"), "ref: refs/heads/main\n")
  await mkdir(join(base, "node_modules", "dep"), { recursive: true })
  await writeFile(join(base, "node_modules", "dep", "i.js"), "module.exports = {}\n")
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skipper-wfs-"))
  await seedTree(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("readTextFile", () => {
  test("reads file contents as UTF-8", async () => {
    expect(await readTextFile(join(root, "README.md"))).toBe("# hello\n")
  })

  test("rejects for a missing file", async () => {
    await expect(readTextFile(join(root, "nope.md"))).rejects.toThrow()
  })
})

describe("listDir", () => {
  test("lists immediate children, directories first", async () => {
    const entries = await listDir(root)
    const names = entries.map((e) => e.name)
    // .git and node_modules are real children — listDir does not filter them.
    expect(names).toContain("src")
    expect(names).toContain("README.md")

    const src = entries.find((e) => e.name === "src")
    expect(src?.kind).toBe("dir")
    expect(src?.path).toBe(join(root, "src"))

    const readme = entries.find((e) => e.name === "README.md")
    expect(readme?.kind).toBe("file")

    // Directories must sort ahead of files.
    const firstFileIdx = entries.findIndex((e) => e.kind === "file")
    const lastDirIdx = entries.map((e) => e.kind).lastIndexOf("dir")
    expect(lastDirIdx).toBeLessThan(firstFileIdx)
  })
})

describe("walkFiles", () => {
  test("collects every file and skips .git / node_modules", async () => {
    const files = await walkFiles(root)
    expect(files).toContain(join(root, "README.md"))
    expect(files).toContain(join(root, "src", "index.ts"))
    expect(files).toContain(join(root, "src", "util", "helpers.ts"))

    expect(files.some((f) => f.includes(`${".git"}/`) || f.includes("/.git/"))).toBe(false)
    expect(files.some((f) => f.includes("node_modules"))).toBe(false)
  })

  test("honours an additional ignore entry", async () => {
    const files = await walkFiles(root, { ignore: ["util"] })
    expect(files).toContain(join(root, "src", "index.ts"))
    expect(files).not.toContain(join(root, "src", "util", "helpers.ts"))
  })

  test("respects maxDepth (0 = only the root's own files)", async () => {
    const files = await walkFiles(root, { maxDepth: 0 })
    expect(files).toEqual([join(root, "README.md")])
  })

  test("respects limit", async () => {
    const files = await walkFiles(root, { limit: 1 })
    expect(files).toHaveLength(1)
  })
})
