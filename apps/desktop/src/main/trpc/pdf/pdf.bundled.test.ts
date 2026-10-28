import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { afterEach, expect, test } from "vitest"
import { createHarness, type Harness } from "../testHarness"

let h: Harness | undefined
afterEach(async () => {
  await h?.dispose()
  h = undefined
})

/** Real bundled compiler and mapping reader, with preloaded package cache and no system TeX discovery. */
test.skipIf(!process.env.PI_LAB_TECTONIC_TEST_CACHE)(
  "bundled Tectonic builds and navigates nested source without system TeX",
  async () => {
    h = await createHarness([], {
      git: false,
      daemon: "lazy",
      latexResourcesDir: resolve("apps/desktop/resources/latex"),
      resolveAgentExecutable: async () => null,
      getAgentLaunchEnvironment: async () => ({ PATH: "/usr/bin:/bin" }),
    })
    // Copy only test packages into the isolated cache. No compiler is resolved from this cache.
    const data = join(h.dataDir, "latex")
    await mkdir(data)
    await cp(process.env.PI_LAB_TECTONIC_TEST_CACHE as string, join(data, "cache"), {
      recursive: true,
    })
    const project = await h.caller.projects.open({ path: h.repoDir })
    const workspace = await h.caller.workspaces.ensureMain({ projectId: project.id })
    await mkdir(join(h.repoDir, "paper", "chapters"), { recursive: true })
    await writeFile(
      join(h.repoDir, "paper/main.tex"),
      "\\documentclass{article}\n\\begin{document}\n\\input{chapters/body}\n\\end{document}\n",
    )
    await writeFile(
      join(h.repoDir, "paper/chapters/body.tex"),
      "% !TeX root = ../main.tex\nA bundled compiler sentence.\\par\nSecond sentence.\n",
    )
    expect((await h.caller.settings.get()).editor.latexProvider).toBe("bundled")
    const built = await h.caller.pdf.build({
      workspaceId: workspace.id,
      relPath: "paper/chapters/body.tex",
    })
    expect(built.success, built.log).toBe(true)
    expect((await readFile(join(h.repoDir, built.relPath))).subarray(0, 5).toString()).toBe("%PDF-")
    const target = await h.caller.pdf.forwardSync({
      workspaceId: workspace.id,
      relPath: "paper/chapters/body.tex",
      line: 2,
      column: 1,
    })
    expect(target.page).toBe(1)
    const source = await h.caller.pdf.reverseSync({
      workspaceId: workspace.id,
      relPath: target.relPath,
      page: target.page,
      x: target.x,
      y: target.y,
    })
    expect(source.relPath).toBe("paper/chapters/body.tex")
    expect(source.line).toBe(2)
    const before = await h.caller.pdf.read({ workspaceId: workspace.id, relPath: built.relPath })
    await writeFile(
      join(h.repoDir, "paper/chapters/body.tex"),
      "% !TeX root = ../main.tex\nUpdated bundled compiler sentence, a longer new version.\n",
    )
    const rebuilt = await h.caller.pdf.build({
      workspaceId: workspace.id,
      relPath: "paper/main.tex",
    })
    expect(rebuilt.success, rebuilt.log).toBe(true)
    const after = await h.caller.pdf.read({ workspaceId: workspace.id, relPath: rebuilt.relPath })
    expect(Buffer.compare(Buffer.from(before.data), Buffer.from(after.data))).not.toBe(0)
    await h.caller.settings.updateEditor({ latexProvider: "system" })
    await expect(
      h.caller.pdf.build({ workspaceId: workspace.id, relPath: "paper/main.tex" }),
    ).rejects.toThrow("System PDFLaTeX")
  },
  60_000,
)
