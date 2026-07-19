// Unit tests for the template directory resolver + first-run seed. Each test points
// PI_LAB_DATA_DIR at a throwaway temp dir so the writable copy is hermetic; the
// bundled source is read from `apps/desktop/resources/template` (md/engineering/testing-and-build.md).
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveDataDir } from "@pi-lab/local-db"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { resolveWritableTemplateDir, seedWritableTemplate } from "./templateDir"

let dataDir: string
let previousDataDir: string | undefined

beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(join(tmpdir(), "pi-lab-tpl-dir-")))
  previousDataDir = process.env.PI_LAB_DATA_DIR
  process.env.PI_LAB_DATA_DIR = dataDir
})

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.PI_LAB_DATA_DIR
  else process.env.PI_LAB_DATA_DIR = previousDataDir
  await rm(dataDir, { recursive: true, force: true })
})

describe("resolveWritableTemplateDir", () => {
  test("is `template` under the resolved data dir", () => {
    expect(resolveWritableTemplateDir()).toBe(join(resolveDataDir(), "template"))
    expect(resolveWritableTemplateDir()).toBe(join(dataDir, "template"))
  })
})

describe("seedWritableTemplate", () => {
  test("seeds the bundled files on first run", async () => {
    await seedWritableTemplate()
    expect((await readFile(join(dataDir, "template", "AGENTS.md"), "utf8")).length).toBeGreaterThan(
      0,
    )
  })

  test("is idempotent — a second call never overwrites the user's edits", async () => {
    await seedWritableTemplate()

    const agents = join(dataDir, "template", "AGENTS.md")
    await writeFile(agents, "# user edit\n")

    // The writable dir already exists, so this must be a no-op.
    await seedWritableTemplate()
    expect(await readFile(agents, "utf8")).toBe("# user edit\n")
  })
})
