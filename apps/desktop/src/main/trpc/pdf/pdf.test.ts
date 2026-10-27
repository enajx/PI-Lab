import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeAll, beforeEach, expect, test } from "vitest"
import { liveAgentExecutableResolver } from "../../agents/executable"
import { createHarness, type Harness } from "../testHarness"

let h: Harness
let workspaceId: string
let missingTools: string[] = []

// These two tests cross the real installed TeX boundary and explicitly skip on hosts without it.
beforeAll(async () => {
  const tools = ["latexmk", "pdflatex", "synctex"]
  const paths = await Promise.all(
    tools.map((tool) => liveAgentExecutableResolver(tool).catch(() => null)),
  )
  missingTools = tools.filter((_, index) => !paths[index])
})

beforeEach(async () => {
  h = await createHarness([], {
    git: false,
    daemon: "lazy",
    resolveAgentExecutable: liveAgentExecutableResolver,
  })
  await h.caller.settings.updateEditor({ latexProvider: "system" })
  const project = await h.caller.projects.open({ path: h.repoDir })
  const workspace = await h.caller.workspaces.ensureMain({ projectId: project.id })
  workspaceId = workspace.id
})
afterEach(async () => {
  await h.dispose()
})

/** Real PDF bytes and path boundaries through the public router. */
test("reads PDF bytes and rejects non-PDF and escaped symlink files", async () => {
  await writeFile(join(h.repoDir, "paper.pdf"), "%PDF-1.4\nfixture")
  const result = await h.caller.pdf.read({ workspaceId, relPath: "paper.pdf" })
  expect(Buffer.from(result.data).toString()).toBe("%PDF-1.4\nfixture")
  expect(result.baseline.size).toBe(16)
  await writeFile(join(h.repoDir, "fake.pdf"), "ordinary text")
  await expect(h.caller.pdf.read({ workspaceId, relPath: "fake.pdf" })).rejects.toThrow("PDF")
  await writeFile(join(h.dataDir, "outside.pdf"), "%PDF-1.4")
  await symlink(join(h.dataDir, "outside.pdf"), join(h.repoDir, "escape.pdf"))
  await expect(h.caller.pdf.read({ workspaceId, relPath: "escape.pdf" })).rejects.toMatchObject({
    code: "FORBIDDEN",
  })
})

/** Exercises installed latexmk and SyncTeX, not injected commands. */
test("builds a chapter via its root and navigates PDF and source in both directions", async (context) => {
  if (missingTools.length) context.skip(`Requires installed TeX tools: ${missingTools.join(", ")}`)
  await mkdir(join(h.repoDir, "chapters"))
  await writeFile(
    join(h.repoDir, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\n\\input{chapters/body}\n\\end{document}\n",
  )
  await writeFile(
    join(h.repoDir, "chapters/body.tex"),
    "% !TeX root = ../main.tex\nA sentence in the chapter for synchronization.\n",
  )
  const built = await h.caller.pdf.build({ workspaceId, relPath: "chapters/body.tex" })
  expect(built.success, built.log).toBe(true)
  expect(built.relPath).toBe("build/main.pdf")
  expect((await readFile(join(h.repoDir, built.relPath))).subarray(0, 5).toString()).toBe("%PDF-")
  const forward = await h.caller.pdf.forwardSync({
    workspaceId,
    relPath: "chapters/body.tex",
    line: 2,
    column: 1,
  })
  expect(forward.relPath).toBe("build/main.pdf")
  expect(forward.page).toBe(1)
  const reverse = await h.caller.pdf.reverseSync({
    workspaceId,
    relPath: forward.relPath,
    page: forward.page,
    x: forward.x,
    y: forward.y,
  })
  expect(reverse.relPath).toBe("chapters/body.tex")
  expect(reverse.line).toBe(2)
  await writeFile(
    join(h.repoDir, "chapters/body.tex"),
    "% !TeX root = ../main.tex\n\\undefinedcommand\n",
  )
  const failed = await h.caller.pdf.build({ workspaceId, relPath: "chapters/body.tex" })
  expect(failed.success).toBe(false)
  expect(failed.log).toContain("Undefined control sequence")
}, 30_000)

/** Missing mappings and root comments must fail visibly without leaving the workspace. */
test("rejects missing SyncTeX and escaping root comments", async () => {
  await writeFile(join(h.repoDir, "paper.pdf"), "%PDF-1.4\nfixture")
  await expect(
    h.caller.pdf.reverseSync({ workspaceId, relPath: "paper.pdf", page: 1, x: 10, y: 10 }),
  ).rejects.toThrow("No SyncTeX mapping")
  await writeFile(join(h.dataDir, "outside.tex"), "\\documentclass{article}")
  await writeFile(join(h.repoDir, "chapter.tex"), "% !TeX root = ../outside.tex\nchapter")
  await expect(h.caller.pdf.build({ workspaceId, relPath: "chapter.tex" })).rejects.toMatchObject({
    code: "FORBIDDEN",
  })
  await symlink(join(h.dataDir, "outside.tex"), join(h.repoDir, "paper.synctex"))
  await expect(
    h.caller.pdf.reverseSync({ workspaceId, relPath: "paper.pdf", page: 1, x: 10, y: 10 }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" })
})

/** Root files in subfolders retain their own build directory and source paths. */
test("synchronizes a document whose root is in a subfolder", async (context) => {
  if (missingTools.length) context.skip(`Requires installed TeX tools: ${missingTools.join(", ")}`)
  await mkdir(join(h.repoDir, "paper"))
  await writeFile(
    join(h.repoDir, "paper/main.tex"),
    "\\documentclass{article}\n\\begin{document}\nNested source sentence.\n\\end{document}\n",
  )
  const built = await h.caller.pdf.build({ workspaceId, relPath: "paper/main.tex" })
  expect(built.success, built.log).toBe(true)
  const forward = await h.caller.pdf.forwardSync({
    workspaceId,
    relPath: "paper/main.tex",
    line: 3,
    column: 1,
  })
  expect(forward.relPath).toBe("paper/build/main.pdf")
  const reverse = await h.caller.pdf.reverseSync({
    workspaceId,
    relPath: forward.relPath,
    page: forward.page,
    x: forward.x,
    y: forward.y,
  })
  expect(reverse.relPath).toBe("paper/main.tex")
}, 30_000)

/** A missing PDF produces a visible filesystem error instead of an empty byte stream. */
test("rejects a missing PDF and a root-comment symlink escape", async () => {
  await expect(h.caller.pdf.read({ workspaceId, relPath: "missing.pdf" })).rejects.toThrow("ENOENT")
  await writeFile(join(h.dataDir, "outside.tex"), "\\documentclass{article}")
  await symlink(join(h.dataDir, "outside.tex"), join(h.repoDir, "linked-root.tex"))
  await writeFile(join(h.repoDir, "chapter.tex"), "% !TeX root = linked-root.tex\nchapter")
  await expect(h.caller.pdf.build({ workspaceId, relPath: "chapter.tex" })).rejects.toMatchObject({
    code: "FORBIDDEN",
  })
})
