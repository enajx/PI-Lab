import { execFile } from "node:child_process"
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
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

/** Installed latexmk and SyncTeX: builds and SyncTeX follow the configured output folder. */
test("builds into the paper's output folder or the global default, and excludes it from the paper repo", async (context) => {
  if (missingTools.length) context.skip(`Requires installed TeX tools: ${missingTools.join(", ")}`)
  const doc =
    "\\documentclass{article}\n\\begin{document}\nOutput folder sentence.\n\\end{document}\n"
  // Outside a paper: the global default.
  await h.caller.settings.updateEditor({ latexOutputDir: "pdfs" })
  await writeFile(join(h.repoDir, "main.tex"), doc)
  const plain = await h.caller.pdf.build({ workspaceId, relPath: "main.tex" })
  expect(plain.success, plain.log).toBe(true)
  expect(plain.relPath).toBe("pdfs/main.pdf")

  // A linked paper (its own Git repo) with an override, then ".".
  const paperDir = join(h.dataDir, "paper")
  await mkdir(paperDir)
  await promisify(execFile)("git", ["init", "-q", paperDir])
  await writeFile(join(paperDir, "main.tex"), doc)
  await writeFile(join(paperDir, "other.tex"), doc)
  const projectId = (await h.caller.projects.list())[0]?.id ?? ""
  const linked = await h.caller.paper.link({ projectId, dir: paperDir, rootChoice: null })
  const paperWorkspace = linked.workspaceId ?? ""
  await h.caller.paper.setOutputDir({ projectId, outputDir: "out/pdf" })
  const built = await h.caller.pdf.build({ workspaceId: paperWorkspace, relPath: "main.tex" })
  expect(built.success, built.log).toBe(true)
  expect(built.relPath).toBe("out/pdf/main.pdf")
  const forward = await h.caller.pdf.forwardSync({
    workspaceId: paperWorkspace,
    relPath: "main.tex",
    line: 3,
    column: 1,
  })
  expect(forward.relPath).toBe("out/pdf/main.pdf")

  await h.caller.paper.setOutputDir({ projectId, outputDir: "." })
  const beside = await h.caller.pdf.build({ workspaceId: paperWorkspace, relPath: "other.tex" })
  expect(beside.success, beside.log).toBe(true)
  expect(beside.relPath).toBe("other.pdf")
  const nextTo = await h.caller.pdf.forwardSync({
    workspaceId: paperWorkspace,
    relPath: "other.tex",
    line: 3,
    column: 1,
  })
  expect(nextTo.relPath).toBe("other.pdf")
  // The build excludes the outputs of the root it built, not only main.tex's.
  const exclude = (await readFile(join(paperDir, ".git", "info", "exclude"), "utf8")).split("\n")
  expect(exclude).toContain("/out/pdf/")
  expect(exclude).toContain("/other.pdf")
  expect(exclude).toContain("/other.synctex.gz")
}, 60_000)

test("a build in the project folder linked with Sync off writes no exclude rule", async (context) => {
  if (missingTools.length) context.skip(`Requires installed TeX tools: ${missingTools.join(", ")}`)
  await promisify(execFile)("git", ["init", "-q", h.repoDir])
  const excludePath = join(h.repoDir, ".git", "info", "exclude")
  const before = await readFile(excludePath, "utf8")
  await writeFile(
    join(h.repoDir, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nRoot paper.\n\\end{document}\n",
  )
  const projectId = (await h.caller.projects.list())[0]?.id ?? ""
  const linked = await h.caller.paper.link({ projectId, dir: h.repoDir, rootChoice: "no-sync" })
  const built = await h.caller.pdf.build({
    workspaceId: linked.workspaceId ?? "",
    relPath: "main.tex",
  })
  expect(built.success, built.log).toBe(true)
  expect(await readFile(excludePath, "utf8")).toBe(before)
}, 60_000)

test("a Project view build of a paper inside the project uses the paper's output folder, and Sync sends no output", async (context) => {
  if (missingTools.length) context.skip(`Requires installed TeX tools: ${missingTools.join(", ")}`)
  const git = (dir: string, ...args: string[]) =>
    promisify(execFile)("git", [
      "-C",
      dir,
      "-c",
      "user.name=PI Lab Test",
      "-c",
      "user.email=test@example.invalid",
      ...args,
    ])
  // A stand-in Overleaf remote, cloned as the paper folder inside the project.
  const remote = join(h.dataDir, "remote.git")
  await promisify(execFile)("git", ["init", "-q", "--bare", "-b", "main", remote])
  const paperDir = join(h.repoDir, "paper")
  await promisify(execFile)("git", ["clone", "-q", remote, paperDir])
  await writeFile(
    join(paperDir, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nInside paper.\n\\end{document}\n",
  )
  await git(paperDir, "add", "main.tex")
  await git(paperDir, "commit", "-q", "-m", "seed")
  await git(paperDir, "push", "-q", "origin", "HEAD:main")
  const projectId = (await h.caller.projects.list())[0]?.id ?? ""
  await h.caller.paper.link({ projectId, dir: paperDir, rootChoice: null })
  await h.caller.paper.setOutputDir({ projectId, outputDir: "out" })

  // Built from the Project view (the main workspace), not the LaTeX Editor.
  const built = await h.caller.pdf.build({ workspaceId, relPath: "paper/main.tex" })
  expect(built.success, built.log).toBe(true)
  expect(built.relPath).toBe("paper/out/main.pdf")
  const forward = await h.caller.pdf.forwardSync({
    workspaceId,
    relPath: "paper/main.tex",
    line: 3,
    column: 1,
  })
  expect(forward.relPath).toBe("paper/out/main.pdf")

  const status = await h.caller.paper.sync({ projectId, commit: true })
  expect(status.state).toBe("synced")
  const { stdout } = await promisify(execFile)("git", [
    "-C",
    remote,
    "ls-tree",
    "-r",
    "--name-only",
    "main",
  ])
  expect(stdout.trim().split("\n")).toEqual(["main.tex"])
}, 60_000)

/** Installed latexmk: a saved .tex with no root of its own builds the paper's main document. */
test("a .tex with no root of its own builds the saved main document, else an ancestor main.tex, else the guess", async (context) => {
  if (missingTools.length) context.skip(`Requires installed TeX tools: ${missingTools.join(", ")}`)
  const root = (body: string): string =>
    `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`
  const paperDir = join(h.dataDir, "paper")
  await mkdir(join(paperDir, "sections"), { recursive: true })
  await promisify(execFile)("git", ["init", "-q", paperDir])
  await writeFile(join(paperDir, "main.tex"), root("Main document."))
  await writeFile(join(paperDir, "thesis.tex"), root("\\input{sections/intro}"))
  await writeFile(join(paperDir, "sections", "intro.tex"), "Introduction sentence.\n")
  const projectId = (await h.caller.projects.list())[0]?.id ?? ""
  const linked = await h.caller.paper.link({ projectId, dir: paperDir, rootChoice: null })
  const paperWorkspace = linked.workspaceId ?? ""
  const build = (): ReturnType<typeof h.caller.pdf.build> =>
    h.caller.pdf.build({ workspaceId: paperWorkspace, relPath: "sections/intro.tex" })
  expect((await build()).relPath).toBe("build/main.pdf")
  await h.caller.paper.setMainDoc({ projectId, mainDoc: "thesis.tex" })
  const chosen = await build()
  expect(chosen.success, chosen.log).toBe(true)
  expect(chosen.relPath).toBe("build/thesis.pdf")
  // No saved choice and no ancestor main.tex: the guessed main document.
  await h.caller.paper.setMainDoc({ projectId, mainDoc: "" })
  await rm(join(paperDir, "main.tex"))
  await writeFile(join(paperDir, "other.tex"), root("Other."))
  await writeFile(join(paperDir, "thesis.pdf"), "%PDF-")
  expect((await build()).relPath).toBe("build/thesis.pdf")
  // A saved main document that was deleted afterwards is passed over.
  await h.caller.paper.setMainDoc({ projectId, mainDoc: "other.tex" })
  await rm(join(paperDir, "other.tex"))
  expect((await build()).relPath).toBe("build/thesis.pdf")
}, 60_000)
