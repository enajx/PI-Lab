import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { findDocumentTool, piLabToolPath } from "./tools"

/**
 * Tool detection, with stand-in `quarto` and `myst` shell scripts (not the real
 * tools) on a temporary PATH and in a temporary PI Lab tools folder.
 */

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-doc-tools-"))
  directories.push(dir)
  return dir
}

/** Write an executable stand-in that prints `version` for `--version`. */
async function standIn(path: string, version: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, `#!/bin/sh\necho "${version}"\n`)
  await chmod(path, 0o755)
}

const env = (path: string) => ({ PATH: `${path}:/usr/bin:/bin` })

describe("findDocumentTool", () => {
  test("finds a stand-in quarto on PATH and reads its version", async () => {
    const bin = await tempDir()
    const toolsDir = await tempDir()
    await standIn(join(bin, "quarto"), "1.2.3")

    const found = await findDocumentTool("quarto", toolsDir, env(bin), [])

    expect(found).toEqual({ path: join(bin, "quarto"), version: "1.2.3", error: null })
  })

  test("finds a stand-in myst in one of the extra folders", async () => {
    const extra = await tempDir()
    const toolsDir = await tempDir()
    await standIn(join(extra, "myst"), "v1.12.0")

    const found = await findDocumentTool("myst", toolsDir, env("/nonexistent"), [extra])

    expect(found?.path).toBe(join(extra, "myst"))
    expect(found?.version).toBe("v1.12.0")
  })

  test("uses PI Lab's own install before PATH", async () => {
    const bin = await tempDir()
    const toolsDir = await tempDir()
    await standIn(join(bin, "myst"), "system")
    await standIn(piLabToolPath(toolsDir, "myst"), "pi-lab")

    const found = await findDocumentTool("myst", toolsDir, env(bin), [])

    expect(found?.path).toBe(piLabToolPath(toolsDir, "myst"))
    expect(found?.version).toBe("pi-lab")
  })

  test("returns null when the tool is in none of the folders", async () => {
    const toolsDir = await tempDir()
    expect(await findDocumentTool("quarto", toolsDir, env("/nonexistent"), [])).toBeNull()
  })

  test("reports a found tool whose --version fails, with the error", async () => {
    const bin = await tempDir()
    const toolsDir = await tempDir()
    await writeFile(join(bin, "quarto"), "#!/bin/sh\necho broken >&2\nexit 3\n")
    await chmod(join(bin, "quarto"), 0o755)

    const found = await findDocumentTool("quarto", toolsDir, env(bin), [])

    expect(found?.path).toBe(join(bin, "quarto"))
    expect(found?.version).toBeNull()
    expect(found?.error).toContain("broken")
  })
})
