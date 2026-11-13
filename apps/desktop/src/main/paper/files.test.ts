// Main document guess of a paper folder, on real temporary folders.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { guessMainDoc, listPaperFiles, paperMainDoc } from "./files"

const DOC = "\\documentclass{article}\n\\begin{document}\nText.\n\\end{document}\n"
const PART = "\\section{Part}\nText.\n"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-lab-main-doc-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Write files (path relative to the paper folder → content). */
async function write(files: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, relPath)), { recursive: true })
    await writeFile(join(dir, relPath), content)
  }
}

/** The guess for the current folder, with `build` as the output folder. */
async function guess(): Promise<string | null> {
  return guessMainDoc(dir, (await listPaperFiles(dir)).files, "build")
}

test("main.tex at the top wins over a .tex with a matching PDF", async () => {
  await write({ "main.tex": DOC, "paper.tex": DOC, "paper.pdf": "%PDF-" })
  expect(await guess()).toBe("main.tex")
})

test("else the .tex with a matching PDF next to it or in the output folder", async () => {
  await write({ "paper.tex": DOC, "notes.tex": DOC, "paper.pdf": "%PDF-" })
  expect(await guess()).toBe("paper.tex")
  await rm(join(dir, "paper.pdf"))
  await write({ "build/notes.pdf": "%PDF-" })
  expect(await guess()).toBe("notes.tex")
})

test("else the single .tex with an uncommented \\documentclass", async () => {
  await write({ "thesis.tex": DOC, "intro.tex": PART, "old.tex": `% ${DOC}` })
  expect(await guess()).toBe("thesis.tex")
})

test("no guess when several .tex files have \\documentclass, or none has", async () => {
  await write({ "a.tex": DOC, "b.tex": DOC })
  expect(await guess()).toBeNull()
  await rm(dir, { recursive: true, force: true })
  await write({ "part.tex": PART })
  expect(await guess()).toBeNull()
})

test("reads only a bounded number of the shallowest .tex files", async () => {
  const parts: Record<string, string> = {}
  for (let index = 0; index < 60; index += 1) parts[`part-${index}.tex`] = PART
  await write({ ...parts, "deep/inside/doc.tex": DOC })
  expect(await guess()).toBeNull()
})

test("a saved main document wins while it is listed; else the guess", async () => {
  await write({ "main.tex": DOC, "other.tex": DOC })
  const files = (await listPaperFiles(dir)).files
  expect(await paperMainDoc(dir, "other.tex", files, "build")).toBe("other.tex")
  expect(await paperMainDoc(dir, "gone.tex", files, "build")).toBe("main.tex")
  expect(await paperMainDoc(dir, undefined, files, "build")).toBe("main.tex")
})
