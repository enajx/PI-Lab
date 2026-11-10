// Tests for the LaTeX template used by "Create paper": the built-in template
// shipped with PI Lab and the user's own template set in Settings > LaTeX.
// They run on real temp folders. One test injects a failing `rename` (mocked).
import { existsSync } from "node:fs"
import * as fsPromises from "node:fs/promises"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  BUILT_IN_TEMPLATE,
  clearCustomTemplate,
  setCustomTemplate,
  templateStatus,
  writeTemplate,
} from "./template"

// `rename` is the real one unless a test replaces it (see "a failed swap ...").
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

let root: string
let dataDir: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pi-lab-template-")))
  dataDir = join(root, "data")
  await mkdir(dataDir)
})

afterEach(async () => {
  vi.mocked(fsPromises.rename).mockRestore()
  await rm(root, { recursive: true, force: true })
})

/** A user template folder with a .tex file, a sub folder and a .git folder. */
async function userTemplate(): Promise<string> {
  const dir = join(root, "my-template")
  await mkdir(join(dir, "figures"), { recursive: true })
  await mkdir(join(dir, ".git"))
  await writeFile(join(dir, "paper.tex"), "\\documentclass{article}\n")
  await writeFile(join(dir, "figures", "logo.png"), "png")
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n")
  await writeFile(join(dir, ".DS_Store"), "x")
  return dir
}

describe("LaTeX template", () => {
  test("the built-in template is main.tex, references.bib and style.sty", async () => {
    expect(BUILT_IN_TEMPLATE.map((file) => file.relPath).sort()).toEqual([
      "main.tex",
      "references.bib",
      "style.sty",
    ])
    expect(await templateStatus(dataDir)).toEqual({ custom: null })
    const target = join(root, "paper")
    await mkdir(target)
    await writeTemplate(dataDir, target)
    expect(await readFile(join(target, "main.tex"), "utf8")).toContain("\\usepackage{style}")
    expect(existsSync(join(target, "references.bib"))).toBe(true)
    expect(existsSync(join(target, "style.sty"))).toBe(true)
  })

  test("a user template is copied in, without .git or .DS_Store, and replaces the built-in one", async () => {
    const source = await userTemplate()
    const status = await setCustomTemplate(dataDir, source)
    expect(status.custom?.source).toBe(source)
    expect(status.custom?.files).toEqual(["figures/logo.png", "paper.tex"])
    // Later changes to the source folder do not change the saved template.
    await rm(source, { recursive: true })
    const target = join(root, "paper")
    await mkdir(target)
    await writeTemplate(dataDir, target)
    expect(await readFile(join(target, "paper.tex"), "utf8")).toBe("\\documentclass{article}\n")
    expect(existsSync(join(target, "figures", "logo.png"))).toBe(true)
    expect(existsSync(join(target, ".git"))).toBe(false)
    expect(existsSync(join(target, ".DS_Store"))).toBe(false)
    expect(existsSync(join(target, "main.tex"))).toBe(false)
  })

  test("setting a new template replaces the old one, and clearing goes back to the built-in one", async () => {
    await setCustomTemplate(dataDir, await userTemplate())
    const second = join(root, "second")
    await mkdir(second)
    await writeFile(join(second, "thesis.tex"), "thesis\n")
    expect((await setCustomTemplate(dataDir, second)).custom?.files).toEqual(["thesis.tex"])
    expect(await clearCustomTemplate(dataDir)).toEqual({ custom: null })
    const target = join(root, "paper")
    await mkdir(target)
    await writeTemplate(dataDir, target)
    expect(existsSync(join(target, "main.tex"))).toBe(true)
    expect(existsSync(join(target, "thesis.tex"))).toBe(false)
  })

  test("a failed swap (injected rename error) keeps the old template in use and reports the error", async () => {
    const first = await userTemplate()
    await setCustomTemplate(dataDir, first)
    const second = join(root, "second")
    await mkdir(second)
    await writeFile(join(second, "thesis.tex"), "thesis\n")
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
      if (String(from).endsWith("latex-template.new")) throw new Error("injected rename failure")
      return actual.rename(from, to)
    })
    await expect(setCustomTemplate(dataDir, second)).rejects.toThrow("injected rename failure")
    vi.mocked(fsPromises.rename).mockImplementation(actual.rename)
    const status = await templateStatus(dataDir)
    expect(status.custom?.source).toBe(first)
    expect(status.custom?.files).toEqual(["figures/logo.png", "paper.tex"])
    expect(existsSync(join(dataDir, "latex-template.old"))).toBe(false)
  })

  test("refuses a folder with no .tex file at its top level, or with a symbolic link", async () => {
    const empty = join(root, "empty")
    await mkdir(join(empty, "sub"), { recursive: true })
    await writeFile(join(empty, "sub", "deep.tex"), "x")
    await expect(setCustomTemplate(dataDir, empty)).rejects.toThrow(
      "A LaTeX template folder needs a .tex file at its top level",
    )
    const linked = await userTemplate()
    await symlink(join(root, "elsewhere"), join(linked, "link"))
    await expect(setCustomTemplate(dataDir, linked)).rejects.toThrow(
      "A LaTeX template folder cannot contain symbolic links: link",
    )
    // A refused folder leaves the built-in template in use.
    expect(await templateStatus(dataDir)).toEqual({ custom: null })
  })
})
