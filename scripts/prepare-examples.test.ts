import { afterAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareExamples } from "./prepare-examples"

const parent = await mkdtemp(join(tmpdir(), "pi-lab-examples-test-"))
afterAll(() => rm(parent, { recursive: true, force: true }))

test("prepares five independent folders and refuses to overwrite them", async () => {
  const destination = join(parent, "projects")
  const paths = await prepareExamples(destination)
  expect(paths).toHaveLength(5)
  expect((await readdir(destination)).sort()).toEqual([
    "cpp-research",
    "julia-research",
    "paper-latex",
    "python-research",
    "software-typescript",
  ])
  for (const path of paths) expect(existsSync(join(path, ".git"))).toBe(false)
  expect(await readFile(join(destination, "python-research", "RESEARCH.md"), "utf8")).toContain(
    "Optical digit classification",
  )
  await expect(prepareExamples(destination)).rejects.toThrow("Destination already exists")
  expect(existsSync(join(destination, "paper-latex", "paper.tex"))).toBe(true)
})
