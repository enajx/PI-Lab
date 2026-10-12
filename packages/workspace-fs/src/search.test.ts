import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { searchFiles } from "./search"

let root: string

async function seedTree(base: string): Promise<void> {
  await mkdir(join(base, "src", "components"), { recursive: true })
  await writeFile(join(base, "src", "index.ts"), "")
  await writeFile(join(base, "src", "components", "Button.tsx"), "")
  await writeFile(join(base, "src", "components", "buttonStyles.css"), "")
  await writeFile(join(base, "README.md"), "")
  await mkdir(join(base, "node_modules", "react"), { recursive: true })
  await writeFile(join(base, "node_modules", "react", "Button.tsx"), "")
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-lab-wfs-search-"))
  await seedTree(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("searchFiles", () => {
  test("ranks the obvious match first", async () => {
    const { hits } = await searchFiles(root, "Button.tsx")
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.path).toBe(join(root, "src", "components", "Button.tsx"))
    // node_modules is pruned, so the duplicate basename there never appears.
    expect(hits.some((h) => h.path.includes("node_modules"))).toBe(false)
  })

  test("returns hits sorted by descending score", async () => {
    const { hits } = await searchFiles(root, "button")
    const scores = hits.map((h) => h.score)
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1] ?? 0).toBeGreaterThanOrEqual(scores[i] ?? 0)
    }
  })

  test("matches against the path, not only the basename", async () => {
    const { hits } = await searchFiles(root, "compbutton")
    expect(hits.map((h) => h.path)).toContain(join(root, "src", "components", "Button.tsx"))
  })

  test("respects the result limit", async () => {
    const { hits } = await searchFiles(root, "s", { limit: 1 })
    expect(hits).toHaveLength(1)
  })

  test("returns nothing for an empty or whitespace query", async () => {
    expect((await searchFiles(root, "")).hits).toEqual([])
    expect((await searchFiles(root, "   ")).hits).toEqual([])
  })

  test("returns nothing when nothing matches", async () => {
    expect((await searchFiles(root, "zzzznotachance")).hits).toEqual([])
  })

  test("prunes virtualenv and output directories but still ranks later eligible paths", async () => {
    for (const dir of [".venv", "build", "out", "dist"]) {
      await mkdir(join(root, dir))
      await writeFile(join(root, dir, "Button.tsx"), "")
    }
    await mkdir(join(root, "zz"))
    await writeFile(join(root, "zz", "Button.tsx"), "")
    const result = await searchFiles(root, "Button.tsx", { limit: 1 })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.path).toBe(join(root, "zz", "Button.tsx"))
    expect(result).toMatchObject({ partial: false, skipped: [] })
  })
})
