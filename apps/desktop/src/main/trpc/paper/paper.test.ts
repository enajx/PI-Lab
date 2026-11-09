// Integration tests for the `paper` router (LaTeX Editor paper folder). They run
// through the tRPC caller over a real SQLite DB and the real git CLI. A local
// bare repo stands in for the Overleaf remote, and a second clone of it plays
// the Overleaf side to create real merge conflicts. The Overleaf clone path is
// tested through `clonePaper` with that bare repo, because the router only
// accepts git.overleaf.com URLs (the host check itself is tested separately).
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { serviceCredentials } from "@pi-lab/local-db"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createHarness, type Harness } from "../testHarness"
import { clonePaper } from "./paper"

const execFileAsync = promisify(execFile)

let h: Harness
let projectId: string
let bare: string

/** Run git in `dir` for fixture setup. */
async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args])
  return stdout
}

/** Clone the bare remote into `dir` with a commit identity. */
async function cloneRemote(dir: string): Promise<void> {
  await execFileAsync("git", ["clone", bare, dir])
  await git(dir, ["config", "user.email", "test@pi-lab.local"])
  await git(dir, ["config", "user.name", "PI Lab Test"])
}

/** Create the bare stand-in remote, seeded with a small paper. */
async function seedRemote(root: string): Promise<string> {
  const remote = join(root, "overleaf.git")
  await execFileAsync("git", ["init", "--bare", "-b", "main", remote])
  const seed = join(root, "seed")
  await execFileAsync("git", ["init", "-b", "main", seed])
  await git(seed, ["config", "user.email", "test@pi-lab.local"])
  await git(seed, ["config", "user.name", "PI Lab Test"])
  await mkdir(join(seed, "sections"))
  await mkdir(join(seed, "figures"))
  await mkdir(join(seed, "build"))
  await writeFile(
    join(seed, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\n\\input{sections/method}\n\\end{document}\n",
  )
  await writeFile(join(seed, "sections", "method.tex"), "\\section{Method}\n\\subsection*{Data}\n")
  await writeFile(join(seed, "refs.bib"), "@article{a, title={A}}\n")
  await writeFile(join(seed, "style.sty"), "% style\n")
  await writeFile(join(seed, "figures", "plot.png"), "png")
  await writeFile(join(seed, "build", "main.tex"), "ignored build output\n")
  await writeFile(join(seed, "notes.txt"), "not listed\n")
  await git(seed, ["add", "."])
  await git(seed, ["commit", "-m", "seed"])
  await git(seed, ["push", remote, "main"])
  return remote
}

beforeEach(async () => {
  h = await createHarness([], { daemon: "lazy" })
  projectId = (await h.caller.projects.open({ path: h.repoDir })).id
  bare = await seedRemote(h.dataDir)
})

afterEach(async () => {
  await h.dispose()
})

/** Clone the remote outside the project and link it, returning the paper folder. */
async function linkOutsideClone(): Promise<string> {
  const dir = join(h.dataDir, "my-paper")
  await cloneRemote(dir)
  await h.caller.paper.link({ projectId, dir })
  return dir
}

/** Make the "Overleaf" side apply `change` to its clone, commit everything, and push. */
async function overleafCommit(change: (theirs: string) => Promise<void>): Promise<void> {
  const theirs = join(h.dataDir, "theirs")
  if (!existsSync(theirs)) await cloneRemote(theirs)
  await git(theirs, ["pull"])
  await change(theirs)
  await git(theirs, ["add", "-A"])
  await git(theirs, ["commit", "-m", "overleaf edit"])
  await git(theirs, ["push"])
}

/** Make the "Overleaf" side change main.tex and push it. */
async function overleafEdit(content: string): Promise<void> {
  await overleafCommit((theirs) => writeFile(join(theirs, "main.tex"), content))
}

/** Paths tracked on the remote's main branch. */
async function remoteFiles(): Promise<string[]> {
  return (await git(bare, ["ls-tree", "-r", "--name-only", "main"])).trim().split("\n")
}

/** Read main.tex as it is on the remote's main branch. */
async function remoteMainTex(): Promise<string> {
  return git(bare, ["show", "main:main.tex"])
}

describe("token", () => {
  test("set, status and clear never return the token and store it encrypted", async () => {
    expect(await h.caller.paper.token.status()).toEqual({ configured: false })
    expect(await h.caller.paper.token.set({ token: "olp_secret" })).toEqual({ configured: true })
    expect(await h.caller.paper.token.status()).toEqual({ configured: true })
    const stored = h.db.select().from(serviceCredentials).all()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.service).toBe("overleaf")
    expect(stored[0]?.encryptedValue).not.toContain("olp_secret")
    expect(await h.caller.paper.token.clear()).toEqual({ configured: false })
    expect(await h.caller.paper.token.status()).toEqual({ configured: false })
  })
})

describe("link, get, files, outline, unlink", () => {
  test("links a cloned folder outside the project and serves it as a hidden paper workspace", async () => {
    expect(await h.caller.paper.get({ projectId })).toEqual({
      paper: null,
      workspaceId: null,
      rootRelPath: null,
    })
    const dir = await linkOutsideClone()
    const result = await h.caller.paper.get({ projectId })
    expect(result.paper).toEqual({ dir, remoteUrl: bare, lastSyncAt: null, isOverleaf: false })
    expect(result.rootRelPath).toBe("main.tex")
    const workspaceId = result.workspaceId
    if (!workspaceId) throw new Error("expected a paper workspace")

    // files.* and pdf.* resolve the paper workspace to the paper folder.
    const read = await h.caller.files.read({ workspaceId, relPath: "sections/method.tex" })
    expect(read).toMatchObject({ content: expect.stringContaining("\\section{Method}") })
    await writeFile(join(dir, "main.pdf"), "%PDF-1.4\n%%EOF\n")
    const pdf = await h.caller.pdf.read({ workspaceId, relPath: "main.pdf" })
    expect(Buffer.from(pdf.data).toString("utf8")).toBe("%PDF-1.4\n%%EOF\n")
    // The paper workspace is not listed with the project's normal workspaces.
    const listed = await h.caller.workspaces.list({ projectId })
    expect(listed.some((workspace) => workspace.id === workspaceId)).toBe(false)

    expect(await h.caller.paper.files({ projectId })).toEqual([
      { relPath: "figures/plot.png", kind: "figure" },
      { relPath: "main.pdf", kind: "figure" },
      { relPath: "main.tex", kind: "tex" },
      { relPath: "refs.bib", kind: "bib" },
      { relPath: "sections/method.tex", kind: "tex" },
      { relPath: "style.sty", kind: "other-text" },
    ])
    expect(await h.caller.paper.outline({ projectId })).toEqual([
      { level: 2, command: "section", title: "Intro", relPath: "main.tex", line: 3 },
      { level: 2, command: "section", title: "Method", relPath: "sections/method.tex", line: 1 },
      {
        level: 3,
        command: "subsection*",
        title: "Data",
        relPath: "sections/method.tex",
        line: 2,
      },
    ])

    // Editing the project's card metadata keeps the paper link.
    await h.caller.projects.setMetadata({ id: projectId, metadata: { venue: "NeurIPS" } })
    expect((await h.caller.paper.get({ projectId })).paper?.dir).toBe(dir)

    await h.caller.paper.unlink({ projectId })
    expect(await h.caller.paper.get({ projectId })).toEqual({
      paper: null,
      workspaceId: null,
      rootRelPath: null,
    })
    expect((await h.caller.projects.get({ id: projectId })).metadata?.venue).toBe("NeurIPS")
    expect(existsSync(join(dir, "main.tex"))).toBe(true)
    await expect(h.caller.files.read({ workspaceId, relPath: "main.tex" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  test("a plain folder inside the project repo has no remote and syncs as no-remote", async () => {
    const dir = join(h.repoDir, "paper")
    await mkdir(dir)
    await writeFile(join(dir, "a.tex"), "% \\documentclass{x}\n")
    await writeFile(join(dir, "b.tex"), "\\documentclass{article}\n\\section{B}\n")
    await h.caller.paper.link({ projectId, dir })
    const result = await h.caller.paper.get({ projectId })
    expect(result.paper?.remoteUrl).toBeNull()
    expect(result.rootRelPath).toBe("b.tex")
    expect(await h.caller.paper.sync({ projectId, commit: true })).toEqual({ state: "no-remote" })
    // The project's own repo got no commit from the sync.
    expect((await git(h.repoDir, ["log", "--oneline"])).trim().split("\n")).toHaveLength(1)
  })

  test("refuses the project folder itself or a folder that contains it", async () => {
    await expect(h.caller.paper.link({ projectId, dir: h.repoDir })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("project folder"),
    })
    await expect(h.caller.paper.link({ projectId, dir: h.dataDir })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    expect((await h.caller.paper.get({ projectId })).paper).toBeNull()
  })

  test("never returns credentials embedded in the remote URL", async () => {
    const dir = await linkOutsideClone()
    const cases: Array<[string, string]> = [
      ["https://user:secret@example.com/x.git", "https://example.com/x.git"],
      ["https://olp_secret@git.overleaf.com/abc", "https://git.overleaf.com/abc"],
      ["https://git@git.overleaf.com/abc", "https://git@git.overleaf.com/abc"],
    ]
    for (const [origin, shown] of cases) {
      await git(dir, ["remote", "set-url", "origin", origin])
      expect((await h.caller.paper.link({ projectId, dir })).paper?.remoteUrl).toBe(shown)
      expect((await h.caller.paper.get({ projectId })).paper?.remoteUrl).toBe(shown)
      expect(JSON.stringify(await h.caller.projects.get({ id: projectId }))).not.toContain("secret")
    }
  })

  test("refuses a missing folder or a file", async () => {
    await expect(
      h.caller.paper.link({ projectId, dir: join(h.dataDir, "nope") }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    const file = join(h.dataDir, "file.tex")
    await writeFile(file, "x")
    await expect(h.caller.paper.link({ projectId, dir: file })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
  })
})

describe("addOverleaf", () => {
  test("accepts only git.overleaf.com URLs and requires a saved token", async () => {
    await expect(
      h.caller.paper.addOverleaf({ projectId, url: "https://github.com/u/p.git" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(
      h.caller.paper.addOverleaf({ projectId, url: "https://git@git.overleaf.com/abc" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "overleaf-token-required" })
  })

  test("refuses when the project already has a paper folder", async () => {
    await h.caller.paper.token.set({ token: "olp_secret" })
    await mkdir(join(h.repoDir, "paper"))
    await expect(
      h.caller.paper.addOverleaf({ projectId, url: "https://git@git.overleaf.com/abc" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  test("clonePaper clones into <project>/paper, excludes it from the project repo, and links it", async () => {
    await clonePaper(h.db, projectId, bare, { env: null })
    const dir = join(h.repoDir, "paper")
    expect(await readFile(join(dir, "main.tex"), "utf8")).toContain("\\section{Intro}")
    const exclude = await readFile(join(h.repoDir, ".git", "info", "exclude"), "utf8")
    expect(exclude.split("\n")).toContain("/paper/")
    expect((await git(h.repoDir, ["status", "--porcelain"])).trim()).toBe("")
    expect((await h.caller.paper.get({ projectId })).paper?.remoteUrl).toBe(bare)
    // Build output is hidden in the paper repo itself, locally, not in its .gitignore.
    const paperExclude = await readFile(join(dir, ".git", "info", "exclude"), "utf8")
    expect(paperExclude.split("\n")).toContain("build/")
    expect(existsSync(join(dir, ".gitignore"))).toBe(false)
  })
})

// Each test runs many real git commands (clones, merges, pushes); they need more than the 5 s default under load.
describe("sync and resolve", { timeout: 30_000 }, () => {
  test("build output is not committed or pushed by sync", async () => {
    const dir = await linkOutsideClone()
    await writeFile(join(dir, "build", "main.aux"), "aux\n")
    await mkdir(join(dir, "sections", "build"))
    await writeFile(join(dir, "sections", "build", "x.log"), "log\n")
    await writeFile(join(dir, "main.tex"), "\\documentclass{article}\nedited\n")
    expect(await h.caller.paper.sync({ projectId, commit: false })).toEqual({
      state: "needs-commit",
      changedFiles: ["main.tex"],
    })
    expect((await h.caller.paper.sync({ projectId, commit: true })).state).toBe("synced")
    const files = await remoteFiles()
    expect(files).not.toContain("build/main.aux")
    expect(files).not.toContain("sections/build/x.log")
  })

  test("a binary conflict is not settled by Sync", async () => {
    const dir = await linkOutsideClone()
    await overleafCommit((theirs) => writeFile(join(theirs, "figures", "plot.png"), "\0theirs"))
    await writeFile(join(dir, "figures", "plot.png"), "\0mine")
    expect(await h.caller.paper.sync({ projectId, commit: true })).toEqual({
      state: "conflict",
      files: ["figures/plot.png"],
    })
    expect(await h.caller.paper.sync({ projectId, commit: true })).toEqual({
      state: "conflict",
      files: ["figures/plot.png"],
    })
  })

  test("a deleted conflicted file stays in conflict instead of failing", async () => {
    const dir = await linkOutsideClone()
    await overleafEdit("\\documentclass{article}\nfrom overleaf\n")
    await writeFile(join(dir, "main.tex"), "\\documentclass{article}\nfrom pi lab\n")
    await h.caller.paper.sync({ projectId, commit: true })
    await rm(join(dir, "main.tex"))
    expect(await h.caller.paper.sync({ projectId, commit: true })).toEqual({
      state: "conflict",
      files: ["main.tex"],
    })
  })

  test("modify/delete conflict: Sync does not settle it; Keep Overleaf version deletes it", async () => {
    const dir = await linkOutsideClone()
    await overleafCommit((theirs) => rm(join(theirs, "sections", "method.tex")))
    await writeFile(join(dir, "sections", "method.tex"), "\\section{Method edited}\n")
    expect(await h.caller.paper.sync({ projectId, commit: true })).toEqual({
      state: "conflict",
      files: ["sections/method.tex"],
    })
    expect(await h.caller.paper.sync({ projectId, commit: true })).toEqual({
      state: "conflict",
      files: ["sections/method.tex"],
    })
    expect((await h.caller.paper.resolve({ projectId, choice: "overleaf" })).state).toBe("synced")
    expect(existsSync(join(dir, "sections", "method.tex"))).toBe(false)
    expect(await remoteFiles()).not.toContain("sections/method.tex")
  })

  test("modify/delete conflict: Keep my version keeps my edit", async () => {
    const dir = await linkOutsideClone()
    await overleafCommit((theirs) => rm(join(theirs, "sections", "method.tex")))
    await writeFile(join(dir, "sections", "method.tex"), "\\section{Method edited}\n")
    await h.caller.paper.sync({ projectId, commit: true })
    expect((await h.caller.paper.resolve({ projectId, choice: "mine" })).state).toBe("synced")
    expect(await git(bare, ["show", "main:sections/method.tex"])).toBe("\\section{Method edited}\n")
  })

  test("deleted here, edited on Overleaf: Keep my version deletes it", async () => {
    const dir = await linkOutsideClone()
    await overleafCommit((theirs) =>
      writeFile(join(theirs, "refs.bib"), "@article{b, title={B}}\n"),
    )
    await rm(join(dir, "refs.bib"))
    expect(await h.caller.paper.sync({ projectId, commit: true })).toEqual({
      state: "conflict",
      files: ["refs.bib"],
    })
    expect((await h.caller.paper.resolve({ projectId, choice: "mine" })).state).toBe("synced")
    expect(await remoteFiles()).not.toContain("refs.bib")
  })

  test("clean folder syncs and records lastSyncAt", async () => {
    await linkOutsideClone()
    const result = await h.caller.paper.sync({ projectId, commit: false })
    expect(result.state).toBe("synced")
    if (result.state !== "synced") throw new Error("expected synced")
    expect((await h.caller.paper.get({ projectId })).paper?.lastSyncAt).toBe(result.lastSyncAt)
  })

  test("unsent edits ask first, then commit and push when allowed", async () => {
    const dir = await linkOutsideClone()
    await writeFile(join(dir, "main.tex"), "\\documentclass{article}\nedited in PI Lab\n")
    await writeFile(join(dir, "new.tex"), "new\n")
    expect(await h.caller.paper.sync({ projectId, commit: false })).toEqual({
      state: "needs-commit",
      changedFiles: ["main.tex", "new.tex"],
    })
    expect((await h.caller.paper.sync({ projectId, commit: true })).state).toBe("synced")
    expect(await remoteMainTex()).toContain("edited in PI Lab")
    expect((await git(dir, ["log", "-1", "--format=%s"])).trim()).toBe("Sync from PI Lab")
  })

  test("conflict, then Keep my version pushes mine", async () => {
    const dir = await linkOutsideClone()
    await overleafEdit("\\documentclass{article}\nfrom overleaf\n")
    await writeFile(join(dir, "main.tex"), "\\documentclass{article}\nfrom pi lab\n")
    expect(await h.caller.paper.sync({ projectId, commit: true })).toEqual({
      state: "conflict",
      files: ["main.tex"],
    })
    // Markers still present: syncing again reports the conflict again.
    expect(await h.caller.paper.sync({ projectId, commit: true })).toEqual({
      state: "conflict",
      files: ["main.tex"],
    })
    expect((await h.caller.paper.resolve({ projectId, choice: "mine" })).state).toBe("synced")
    expect(await remoteMainTex()).toBe("\\documentclass{article}\nfrom pi lab\n")
  })

  test("conflict, then Keep Overleaf version takes theirs", async () => {
    const dir = await linkOutsideClone()
    await overleafEdit("\\documentclass{article}\nfrom overleaf\n")
    await writeFile(join(dir, "main.tex"), "\\documentclass{article}\nfrom pi lab\n")
    await h.caller.paper.sync({ projectId, commit: true })
    expect((await h.caller.paper.resolve({ projectId, choice: "overleaf" })).state).toBe("synced")
    expect(await readFile(join(dir, "main.tex"), "utf8")).toBe(
      "\\documentclass{article}\nfrom overleaf\n",
    )
    expect(await remoteMainTex()).toBe("\\documentclass{article}\nfrom overleaf\n")
  })

  test("conflict resolved by hand in the editor, then Sync finishes the merge", async () => {
    const dir = await linkOutsideClone()
    await overleafEdit("\\documentclass{article}\nfrom overleaf\n")
    await writeFile(join(dir, "main.tex"), "\\documentclass{article}\nfrom pi lab\n")
    await h.caller.paper.sync({ projectId, commit: true })
    await writeFile(join(dir, "main.tex"), "\\documentclass{article}\nboth\n")
    expect((await h.caller.paper.sync({ projectId, commit: false })).state).toBe("synced")
    expect(await remoteMainTex()).toBe("\\documentclass{article}\nboth\n")
  })

  test("restore-conflicts puts the markers back after a rejected agent merge", async () => {
    const dir = await linkOutsideClone()
    await overleafEdit("\\documentclass{article}\nfrom overleaf\n")
    await writeFile(join(dir, "main.tex"), "\\documentclass{article}\nfrom pi lab\n")
    await h.caller.paper.sync({ projectId, commit: true })
    await writeFile(join(dir, "main.tex"), "\\documentclass{article}\nagent merge\n")
    expect(await h.caller.paper.resolve({ projectId, choice: "restore-conflicts" })).toEqual({
      state: "conflict",
      files: ["main.tex"],
    })
    const restored = await readFile(join(dir, "main.tex"), "utf8")
    expect(restored).toContain("<<<<<<< ")
    expect(restored).toContain("from overleaf")
    expect(restored).toContain("from pi lab")
  })
})
