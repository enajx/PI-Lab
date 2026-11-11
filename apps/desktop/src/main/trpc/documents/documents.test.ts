import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { piLabToolPath } from "../../documents/tools"
import { createHarness, type Harness } from "../testHarness"

/**
 * The documents router with stand-in `quarto` and `myst` shell scripts (not the
 * real tools), placed in PI Lab's tools folder inside the test data folder.
 * They write an HTML file where the real tool would.
 */

let h: Harness
let opened: string[]

beforeEach(async () => {
  opened = []
  h = await createHarness([], {
    daemon: "lazy",
    openPath: async (path) => {
      opened.push(path)
      return ""
    },
  })
})

afterEach(async () => {
  await h.dispose()
})

const toolsDir = () => join(h.dataDir, "tools")

async function script(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
}

/** Stand-in quarto: `render <file> --to html --output-dir <dir>` writes `<dir>/<stem>.html`. */
async function standInQuarto(): Promise<void> {
  await script(
    piLabToolPath(toolsDir(), "quarto"),
    [
      'if [ "$1" = "--version" ]; then echo 9.9.9; exit 0; fi',
      'mkdir -p "$6"',
      'stem=$(basename "$2" .qmd)',
      'echo "<h1>rendered $*</h1><p>python=$QUARTO_PYTHON</p>" > "$6/$stem.html"',
      'echo "Output created: $6/$stem.html"',
    ].join("\n"),
  )
}

async function writeProjectFile(relPath: string, content: string): Promise<void> {
  await mkdir(dirname(join(h.repoDir, relPath)), { recursive: true })
  await writeFile(join(h.repoDir, relPath), content)
}

describe("documents.render", () => {
  test("renders a .qmd with quarto into _render next to it and keeps the folder out of Git", async () => {
    await standInQuarto()
    const project = await h.caller.projects.open({ path: h.repoDir })
    await writeProjectFile("results/report.qmd", "---\ntitle: R\n---\n\n# Hi\n")

    const result = await h.caller.documents.render({
      projectId: project.id,
      relPath: "results/report.qmd",
    })

    expect(result.ok).toBe(true)
    expect(result.outputRelPath).toBe("results/_render/report.qmd/report.html")
    expect(result.log).toContain("Output created")
    const html = await readFile(join(h.repoDir, "results/_render/report.qmd/report.html"), "utf8")
    expect(html).toContain("rendered render report.qmd --to html --output-dir _render/report.qmd")
    const exclude = await readFile(join(h.repoDir, ".git", "info", "exclude"), "utf8")
    expect(exclude.split("\n")).toContain("/results/_render/")
  })

  test("sets QUARTO_PYTHON to the project's .venv Python when it exists", async () => {
    await standInQuarto()
    const project = await h.caller.projects.open({ path: h.repoDir })
    await script(join(h.repoDir, ".venv", "bin", "python"), "exit 0")
    await writeProjectFile("a.qmd", "# A\n")

    const result = await h.caller.documents.render({ projectId: project.id, relPath: "a.qmd" })

    const html = await readFile(join(h.repoDir, String(result.outputRelPath)), "utf8")
    expect(html).toContain(`python=${join(h.repoDir, ".venv", "bin", "python")}`)
  })

  test("renders a MyST file with myst build --html from a generated myst.yml", async () => {
    await script(
      piLabToolPath(toolsDir(), "myst"),
      [
        'if [ "$1" = "--version" ]; then echo v1.12.0; exit 0; fi',
        'echo "args: $*"',
        "mkdir -p _build/html",
        "cp myst.yml _build/html/index.html",
      ].join("\n"),
    )
    const project = await h.caller.projects.open({ path: h.repoDir })
    await writeProjectFile("notes/paper.md", "---\ntitle: Paper\n---\n\n# Hi\n")

    const result = await h.caller.documents.render({
      projectId: project.id,
      relPath: "notes/paper.md",
    })

    expect(result.ok).toBe(true)
    expect(result.log).toContain("args: build --html --execute --ci")
    expect(result.outputRelPath).toBe("notes/_render/paper.md/_build/html/index.html")
    const config = await readFile(join(h.repoDir, String(result.outputRelPath)), "utf8")
    expect(config).toContain('- file: "../../paper.md"')
    const exclude = await readFile(join(h.repoDir, ".git", "info", "exclude"), "utf8")
    expect(exclude.split("\n")).toContain("/notes/_render/")
  })

  test("returns the build log and no output when the tool fails", async () => {
    await script(
      piLabToolPath(toolsDir(), "quarto"),
      'if [ "$1" = "--version" ]; then echo 9.9.9; exit 0; fi\necho "ERROR: bad chunk" >&2\nexit 2',
    )
    const project = await h.caller.projects.open({ path: h.repoDir })
    await writeProjectFile("a.qmd", "# A\n")

    const result = await h.caller.documents.render({ projectId: project.id, relPath: "a.qmd" })

    expect(result.ok).toBe(false)
    expect(result.outputRelPath).toBeNull()
    expect(result.log).toContain("ERROR: bad chunk")
    expect(result.log).toContain("exit code 2")
  })

  test("refuses a file that is neither Quarto nor Markdown", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await writeProjectFile("a.txt", "x")
    await expect(
      h.caller.documents.render({ projectId: project.id, relPath: "a.txt" }),
    ).rejects.toThrow(/Quarto \(\.qmd\) or MyST/)
  })
})

describe("documents.tools", () => {
  test("lists the quarto and myst found, with path and version", async () => {
    await standInQuarto()
    const status = await h.caller.documents.tools()
    expect(status.quarto).toEqual({
      path: piLabToolPath(toolsDir(), "quarto"),
      version: "9.9.9",
      error: null,
    })
    expect(status.installation.quarto.state).toBe("idle")
  })
})

describe("documents.openInBrowser", () => {
  test("opens the rendered file with the system's default app", async () => {
    await standInQuarto()
    const project = await h.caller.projects.open({ path: h.repoDir })
    await writeProjectFile("a.qmd", "# A\n")
    const result = await h.caller.documents.render({ projectId: project.id, relPath: "a.qmd" })

    await h.caller.documents.openInBrowser({
      projectId: project.id,
      relPath: String(result.outputRelPath),
    })

    expect(opened).toEqual([join(h.repoDir, "_render/a.qmd/a.html")])
  })
})
