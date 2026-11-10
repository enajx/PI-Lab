// Integration tests for the `paper` router (LaTeX Editor paper folder). They run
// through the tRPC caller over a real SQLite DB and the real git CLI. A local
// bare repo stands in for the Overleaf remote, and a second clone of it plays
// the Overleaf side to create real merge conflicts. The Overleaf clone path is
// tested through `clonePaper` with that bare repo, because the router only
// accepts git.overleaf.com URLs (the host check itself is tested separately).
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { serviceCredentials } from "@pi-lab/local-db"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createHarness, type Harness } from "../testHarness"
import { clonePaper, connectRemote, displayPaperDir } from "./paper"

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

/** Git config values these tests replace, restored after each test. */
const GIT_ENV_KEYS = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const
let previousGitEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  h = await createHarness([], { daemon: "lazy" })
  // Every git call here, including the Overleaf credential lookup, sees only an
  // empty test global config and no system config, so the real keychain
  // (osxkeychain is set in the macOS system config) is never read.
  previousGitEnv = Object.fromEntries(GIT_ENV_KEYS.map((key) => [key, process.env[key]]))
  process.env.GIT_CONFIG_GLOBAL = join(h.dataDir, "test-gitconfig")
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  projectId = (await h.caller.projects.open({ path: h.repoDir })).id
  bare = await seedRemote(h.dataDir)
})

afterEach(async () => {
  for (const key of GIT_ENV_KEYS) {
    const value = previousGitEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await h.dispose()
})

/** Configure a test credential helper (a small script) that holds an Overleaf credential. */
async function useTestCredentialHelper(): Promise<void> {
  const helper = join(h.dataDir, "test-credential-helper.sh")
  await writeFile(
    helper,
    "#!/bin/sh\n[ \"$1\" = get ] || exit 0\nprintf 'username=git\\npassword=helper-secret\\n'\n",
    { mode: 0o700 },
  )
  await execFileAsync("git", ["config", "--global", "credential.helper", helper])
}

/** Clone the remote outside the project and link it, returning the paper folder. */
async function linkOutsideClone(): Promise<string> {
  const dir = join(h.dataDir, "my-paper")
  await cloneRemote(dir)
  await h.caller.paper.link({ projectId, dir, rootChoice: null })
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
    expect(await h.caller.paper.token.status()).toEqual({ configured: false, source: null })
    expect(await h.caller.paper.token.set({ token: "olp_secret" })).toEqual({
      configured: true,
      source: "saved",
    })
    expect(await h.caller.paper.token.status()).toEqual({ configured: true, source: "saved" })
    const stored = h.db.select().from(serviceCredentials).all()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.service).toBe("overleaf")
    expect(stored[0]?.encryptedValue).not.toContain("olp_secret")
    expect(await h.caller.paper.token.clear()).toEqual({ configured: false, source: null })
    expect(await h.caller.paper.token.status()).toEqual({ configured: false, source: null })
  })

  test("finds an Overleaf credential in the user's Git (test helper), never returns or stores it, and a saved token wins", async () => {
    await useTestCredentialHelper()
    const found = await h.caller.paper.token.status()
    expect(found).toEqual({ configured: true, source: "git" })
    expect(JSON.stringify(found)).not.toContain("helper-secret")
    expect(h.db.select().from(serviceCredentials).all()).toHaveLength(0)
    await h.caller.paper.token.set({ token: "olp_secret" })
    expect(await h.caller.paper.token.status()).toEqual({ configured: true, source: "saved" })
    expect(await h.caller.paper.token.clear()).toEqual({ configured: true, source: "git" })
    expect(h.db.select().from(serviceCredentials).all()).toHaveLength(0)
  })
})

describe("link, get, outline, unlink", () => {
  test("links a cloned folder outside the project and serves it as a hidden paper workspace", async () => {
    expect(await h.caller.paper.get({ projectId })).toEqual({
      paper: null,
      workspaceId: null,
      rootRelPath: null,
      autoDetect: true,
    })
    const dir = await linkOutsideClone()
    const result = await h.caller.paper.get({ projectId })
    expect(result.paper).toEqual({
      dir,
      displayDir: expect.any(String),
      remoteUrl: bare,
      lastSyncAt: null,
      isOverleaf: false,
      outputDir: null,
      effectiveOutputDir: "build",
      syncEnabled: true,
    })
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
      autoDetect: false,
    })
    expect((await h.caller.projects.get({ id: projectId })).metadata?.venue).toBe("NeurIPS")
    expect(existsSync(join(dir, "main.tex"))).toBe(true)
    await expect(h.caller.files.read({ workspaceId, relPath: "main.tex" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  test("clearing the paper folder turns auto-detection off until a folder is chosen again", async () => {
    expect((await h.caller.paper.get({ projectId })).autoDetect).toBe(true)
    const dir = await linkOutsideClone()
    expect((await h.caller.paper.get({ projectId })).autoDetect).toBe(true)
    await h.caller.paper.unlink({ projectId })
    expect((await h.caller.paper.get({ projectId })).autoDetect).toBe(false)
    expect((await h.caller.projects.get({ id: projectId })).metadata?.paperAutoDetect).toBe(false)
    await h.caller.paper.link({ projectId, dir, rootChoice: null })
    expect((await h.caller.paper.get({ projectId })).autoDetect).toBe(true)
    expect(
      (await h.caller.projects.get({ id: projectId })).metadata?.paperAutoDetect,
    ).toBeUndefined()
  })

  test("shows the paper folder relative to the project folder, or as the project folder", async () => {
    const inside = join(h.repoDir, "paper")
    await mkdir(inside)
    await writeFile(join(inside, "main.tex"), "\\documentclass{article}\n")
    const check = await h.caller.paper.checkFolder({ projectId, dir: inside })
    expect(check.displayDir).toBe("paper")
    await h.caller.paper.link({ projectId, dir: inside, rootChoice: null })
    expect((await h.caller.paper.get({ projectId })).paper?.displayDir).toBe("paper")
    await writeFile(join(h.repoDir, "main.tex"), "\\documentclass{article}\n")
    expect((await h.caller.paper.checkFolder({ projectId, dir: h.repoDir })).displayDir).toBe(".")
    await h.caller.paper.link({ projectId, dir: h.repoDir, rootChoice: "no-sync" })
    expect((await h.caller.paper.get({ projectId })).paper?.displayDir).toBe(".")
  })

  test("displayPaperDir: relative inside the project, ~ under home, full path elsewhere", () => {
    expect(displayPaperDir("/home/me/proj", "/home/me/proj", "/home/me")).toBe(".")
    expect(displayPaperDir("/home/me/proj/a/paper", "/home/me/proj", "/home/me")).toBe("a/paper")
    expect(displayPaperDir("/home/me/papers/x", "/home/me/proj", "/home/me")).toBe("~/papers/x")
    expect(displayPaperDir("/home/me", "/home/me/proj", "/home/me")).toBe("~")
    expect(displayPaperDir("/opt/papers/x", "/home/me/proj", "/home/me")).toBe("/opt/papers/x")
    expect(displayPaperDir("/home/me/proj2", "/home/me/proj", "/home/me")).toBe("~/proj2")
  })

  test("error messages say paper folder, never link", async () => {
    await writeFile(join(h.repoDir, "main.tex"), "\\documentclass{article}\n")
    await expect(
      h.caller.paper.link({ projectId, dir: h.repoDir, rootChoice: "sync" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Use it for editing and building only"),
    })
    await expect(h.caller.paper.outline({ projectId })).rejects.toMatchObject({
      message: expect.not.stringMatching(/link/i),
    })
    await h.caller.paper.link({ projectId, dir: h.repoDir, rootChoice: "no-sync" })
    await expect(h.caller.paper.sync({ projectId, commit: true })).rejects.toMatchObject({
      message: expect.not.stringMatching(/link/i),
    })
  })

  test("a plain folder inside the project repo has no remote and syncs as no-remote", async () => {
    const dir = join(h.repoDir, "paper")
    await mkdir(dir)
    await writeFile(join(dir, "a.tex"), "% \\documentclass{x}\n")
    await writeFile(join(dir, "b.tex"), "\\documentclass{article}\n\\section{B}\n")
    await h.caller.paper.link({ projectId, dir, rootChoice: null })
    const result = await h.caller.paper.get({ projectId })
    expect(result.paper?.remoteUrl).toBeNull()
    expect(result.rootRelPath).toBe("b.tex")
    expect(await h.caller.paper.sync({ projectId, commit: true })).toEqual({ state: "no-remote" })
    // The project's own repo got no commit from the sync.
    expect((await git(h.repoDir, ["log", "--oneline"])).trim().split("\n")).toHaveLength(1)
  })

  test("Keep my version (resolve) is refused when Sync is off", async () => {
    await writeFile(join(h.repoDir, "main.tex"), "\\documentclass{article}\n")
    await h.caller.paper.link({ projectId, dir: h.repoDir, rootChoice: "no-sync" })
    await expect(h.caller.paper.resolve({ projectId, choice: "mine" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("Sync is off for this paper"),
    })
  })

  test("with Sync off, no build output rule is written to the project's exclude file", async () => {
    const excludePath = join(h.repoDir, ".git", "info", "exclude")
    const before = existsSync(excludePath) ? await readFile(excludePath, "utf8") : null
    const after = async (): Promise<string | null> =>
      existsSync(excludePath) ? readFile(excludePath, "utf8") : null
    await writeFile(join(h.repoDir, "main.tex"), "\\documentclass{article}\n")
    await h.caller.paper.link({ projectId, dir: h.repoDir, rootChoice: "no-sync" })
    expect(await after()).toBe(before)
    await h.caller.paper.setOutputDir({ projectId, outputDir: "." })
    expect(await after()).toBe(before)
    await h.caller.paper.setOutputDir({ projectId, outputDir: "" })
    await h.caller.settings.updateEditor({ latexOutputDir: "pdfs" })
    expect(await after()).toBe(before)
  })

  test("a project folder with no Git remote cannot be linked with Sync", async () => {
    await writeFile(join(h.repoDir, "main.tex"), "\\documentclass{article}\n")
    await expect(
      h.caller.paper.link({ projectId, dir: h.repoDir, rootChoice: "sync" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("has no Git remote"),
    })
    expect((await h.caller.paper.get({ projectId })).paper).toBeNull()
  })

  test("refuses a folder that contains the project folder, even with a choice", async () => {
    for (const rootChoice of [null, "sync", "no-sync"] as const) {
      await expect(
        h.caller.paper.link({ projectId, dir: h.dataDir, rootChoice }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("contains the project folder"),
      })
    }
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
      expect(
        (await h.caller.paper.link({ projectId, dir, rootChoice: null })).paper?.remoteUrl,
      ).toBe(shown)
      expect((await h.caller.paper.get({ projectId })).paper?.remoteUrl).toBe(shown)
      expect(JSON.stringify(await h.caller.projects.get({ id: projectId }))).not.toContain("secret")
    }
  })

  test("refuses a missing folder or a file", async () => {
    await expect(
      h.caller.paper.link({ projectId, dir: join(h.dataDir, "nope"), rootChoice: null }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    const file = join(h.dataDir, "file.tex")
    await writeFile(file, "x")
    await expect(
      h.caller.paper.link({ projectId, dir: file, rootChoice: null }),
    ).rejects.toMatchObject({
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

  test("a credential in the user's Git (test helper) is enough: no token is asked for", async () => {
    await useTestCredentialHelper()
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

describe("build output folder", () => {
  test("a per-paper override is validated, reported, excluded locally, and cleared with an empty value", async () => {
    const dir = await linkOutsideClone()
    await expect(
      h.caller.paper.setOutputDir({ projectId, outputDir: "../outside" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("..") })
    await expect(
      h.caller.paper.setOutputDir({ projectId, outputDir: "/tmp/out" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    const set = await h.caller.paper.setOutputDir({ projectId, outputDir: "out/pdf/" })
    expect(set.paper).toMatchObject({ outputDir: "out/pdf", effectiveOutputDir: "out/pdf" })
    const exclude = async (): Promise<string[]> =>
      (await readFile(join(dir, ".git", "info", "exclude"), "utf8")).split("\n")
    expect(await exclude()).toContain("**/out/pdf/")
    await h.caller.paper.setOutputDir({ projectId, outputDir: "." })
    expect(await exclude()).toContain("/main.pdf")
    const cleared = await h.caller.paper.setOutputDir({ projectId, outputDir: "" })
    expect(cleared.paper).toMatchObject({ outputDir: null, effectiveOutputDir: "build" })
  })

  test("the global default is validated, and papers without an override exclude the new folder", async () => {
    const dir = await linkOutsideClone()
    await expect(h.caller.settings.updateEditor({ latexOutputDir: "../x" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    expect(
      (await h.caller.settings.updateEditor({ latexOutputDir: " pdfout/ " })).latexOutputDir,
    ).toBe("pdfout")
    expect((await h.caller.paper.get({ projectId })).paper?.effectiveOutputDir).toBe("pdfout")
    const exclude = await readFile(join(dir, ".git", "info", "exclude"), "utf8")
    expect(exclude.split("\n")).toContain("pdfout/")
  })
})

describe("build output folder holding tracked files", () => {
  test("a paper's output folder cannot be a folder with files tracked in the paper repo", async () => {
    await linkOutsideClone()
    await expect(
      h.caller.paper.setOutputDir({ projectId, outputDir: "figures" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        'The folder "figures" holds files tracked in the paper repo (figures/plot.png). Choose another folder for the build output.',
    })
    // Any folder holding tracked files is refused.
    await expect(
      h.caller.paper.setOutputDir({ projectId, outputDir: "sections" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    expect((await h.caller.paper.get({ projectId })).paper?.outputDir).toBeNull()
    expect(
      (await h.caller.paper.setOutputDir({ projectId, outputDir: "out" })).paper?.outputDir,
    ).toBe("out")
  })

  test("the global default cannot be a folder with tracked files in a linked paper that uses it", async () => {
    await linkOutsideClone()
    const name = (await h.caller.projects.get({ id: projectId })).name
    await expect(
      h.caller.settings.updateEditor({ latexOutputDir: "figures" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: `The folder "figures" holds files tracked in the paper repo of project "${name}" (figures/plot.png). Choose another folder for the build output.`,
    })
    expect((await h.caller.settings.get()).editor.latexOutputDir).toBe("build")
    // A paper with its own override does not block the default.
    await h.caller.paper.setOutputDir({ projectId, outputDir: "out" })
    expect(
      (await h.caller.settings.updateEditor({ latexOutputDir: "figures" })).latexOutputDir,
    ).toBe("figures")
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

  test("Sync does not commit build output in a custom output folder or next to main.tex", async () => {
    const dir = await linkOutsideClone()
    await h.caller.paper.setOutputDir({ projectId, outputDir: "out/pdf" })
    await mkdir(join(dir, "out", "pdf"), { recursive: true })
    await writeFile(join(dir, "out", "pdf", "main.pdf"), "%PDF-1.4\n")
    await writeFile(join(dir, "out", "pdf", "main.aux"), "aux\n")
    await writeFile(join(dir, "main.tex"), "\\documentclass{article}\nedited\n")
    expect(await h.caller.paper.sync({ projectId, commit: false })).toEqual({
      state: "needs-commit",
      changedFiles: ["main.tex"],
    })
    expect((await h.caller.paper.sync({ projectId, commit: true })).state).toBe("synced")
    expect((await remoteFiles()).filter((file) => file.startsWith("out/"))).toEqual([])

    await h.caller.paper.setOutputDir({ projectId, outputDir: "." })
    for (const extension of [".pdf", ".aux", ".log", ".synctex.gz", ".fdb_latexmk"]) {
      await writeFile(join(dir, `main${extension}`), "output\n")
    }
    // A figure PDF is a source and must still be sent.
    await writeFile(join(dir, "figures", "main.pdf"), "%PDF-1.4\n")
    await writeFile(join(dir, "main.tex"), "\\documentclass{article}\nedited again\n")
    expect(await h.caller.paper.sync({ projectId, commit: false })).toEqual({
      state: "needs-commit",
      changedFiles: ["main.tex", "figures/main.pdf"],
    })
    expect((await h.caller.paper.sync({ projectId, commit: true })).state).toBe("synced")
    const files = await remoteFiles()
    expect(files).toContain("figures/main.pdf")
    expect(files.filter((file) => file.startsWith("main.") && file !== "main.tex")).toEqual([])
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

/** An Overleaf-looking origin URL. Only its host matters to PI Lab's Overleaf check. */
const OVERLEAF_ORIGIN = "https://git@git.overleaf.com/6ae5e243374fe1802d83e27a"

/** Clone the bare remote into `dir` and point its `origin` at `origin` (no network is used). */
async function cloneWithOrigin(dir: string, origin: string): Promise<void> {
  await cloneRemote(dir)
  await git(dir, ["remote", "set-url", "origin", origin])
}

describe("detect Overleaf clones", () => {
  test("finds nothing in a project with no Overleaf clone", async () => {
    await cloneWithOrigin(join(h.repoDir, "code"), "https://github.com/u/p.git")
    expect(await h.caller.paper.detect({ projectId })).toEqual({ clones: [], stoppedEarly: false })
  })

  test("finds the project folder itself when it is an Overleaf clone", async () => {
    await git(h.repoDir, ["remote", "add", "origin", OVERLEAF_ORIGIN])
    expect(await h.caller.paper.detect({ projectId })).toEqual({
      clones: [{ dir: h.repoDir, relPath: "." }],
      stoppedEarly: false,
    })
  })

  test("finds one nested clone and skips hidden, node_modules, build and too-deep folders", async () => {
    await cloneWithOrigin(join(h.repoDir, "writing", "paper"), OVERLEAF_ORIGIN)
    await cloneWithOrigin(join(h.repoDir, "other"), "https://github.com/u/p.git")
    for (const skipped of [
      ".hidden/p",
      ".worktrees/p",
      "node_modules/p",
      "build/p",
      "dist/p",
      "out/p",
      "venv/p",
      "__pycache__/p",
      "a/b/c/d",
    ]) {
      await cloneWithOrigin(join(h.repoDir, skipped), OVERLEAF_ORIGIN)
    }
    expect(await h.caller.paper.detect({ projectId })).toEqual({
      clones: [{ dir: join(h.repoDir, "writing", "paper"), relPath: "writing/paper" }],
      stoppedEarly: false,
    })
  })

  test("finds every nested clone, including one inside another, sorted by path", async () => {
    await git(h.repoDir, ["remote", "add", "origin", OVERLEAF_ORIGIN])
    await cloneWithOrigin(join(h.repoDir, "paper"), OVERLEAF_ORIGIN)
    await cloneWithOrigin(join(h.repoDir, "paper", "appendix"), OVERLEAF_ORIGIN)
    expect(await h.caller.paper.detect({ projectId })).toEqual({
      clones: [
        { dir: h.repoDir, relPath: "." },
        { dir: join(h.repoDir, "paper"), relPath: "paper" },
        { dir: join(h.repoDir, "paper", "appendix"), relPath: "paper/appendix" },
      ],
      stoppedEarly: false,
    })
  })

  test("skips a folder it cannot read and still finds the others", async () => {
    await cloneWithOrigin(join(h.repoDir, "paper"), OVERLEAF_ORIGIN)
    const locked = join(h.repoDir, "locked")
    await mkdir(locked)
    await chmod(locked, 0o000)
    try {
      expect(await h.caller.paper.detect({ projectId })).toEqual({
        clones: [{ dir: join(h.repoDir, "paper"), relPath: "paper" }],
        stoppedEarly: false,
      })
    } finally {
      await chmod(locked, 0o700)
    }
  })

  test("stops after 5,000 folders and says so, keeping what it found", async () => {
    await git(h.repoDir, ["remote", "add", "origin", OVERLEAF_ORIGIN])
    const many = join(h.repoDir, "many")
    await mkdir(many)
    for (let index = 0; index < 5_000; index++) await mkdir(join(many, `d${index}`))
    const result = await h.caller.paper.detect({ projectId })
    expect(result.stoppedEarly).toBe(true)
    expect(result.clones).toEqual([{ dir: h.repoDir, relPath: "." }])
  })
})

describe("project folder as the paper folder", { timeout: 30_000 }, () => {
  test("an Overleaf clone project folder links with no choice and keeps Sync on", async () => {
    await git(h.repoDir, ["remote", "add", "origin", OVERLEAF_ORIGIN])
    expect(await h.caller.paper.checkFolder({ projectId, dir: h.repoDir })).toEqual({
      displayDir: ".",
      projectFolder: true,
      overleaf: true,
      remoteUrl: OVERLEAF_ORIGIN,
      isPaper: true,
      inside: [],
      stoppedEarly: false,
    })
    const state = await h.caller.paper.link({ projectId, dir: h.repoDir, rootChoice: null })
    expect(state.paper?.dir).toBe(h.repoDir)
    expect(state.paper?.syncEnabled).toBe(true)
  })

  test("another project folder needs an explicit choice; the check reports its remote without credentials", async () => {
    await writeFile(join(h.repoDir, "main.tex"), "\\documentclass{article}\n")
    await git(h.repoDir, ["remote", "add", "origin", "https://user:secret@github.com/u/p.git"])
    expect(await h.caller.paper.checkFolder({ projectId, dir: h.repoDir })).toEqual({
      displayDir: ".",
      projectFolder: true,
      overleaf: false,
      remoteUrl: "https://github.com/u/p.git",
      isPaper: true,
      inside: [],
      stoppedEarly: false,
    })
    await expect(
      h.caller.paper.link({ projectId, dir: h.repoDir, rootChoice: null }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("choose whether Sync is on"),
    })
    expect((await h.caller.paper.get({ projectId })).paper).toBeNull()
    const outside = join(h.dataDir, "elsewhere")
    await mkdir(outside)
    await writeFile(join(outside, "paper.tex"), "\\documentclass{article}\n")
    expect(await h.caller.paper.checkFolder({ projectId, dir: outside })).toEqual({
      displayDir: expect.any(String),
      projectFolder: false,
      overleaf: false,
      remoteUrl: null,
      isPaper: true,
      inside: [],
      stoppedEarly: false,
    })
  })

  test("no-sync links it for editing and building, and Sync refuses with a clear message", async () => {
    await writeFile(join(h.repoDir, "main.tex"), "\\documentclass{article}\n")
    const state = await h.caller.paper.link({ projectId, dir: h.repoDir, rootChoice: "no-sync" })
    expect(state.paper?.syncEnabled).toBe(false)
    expect((await h.caller.paper.get({ projectId })).paper?.syncEnabled).toBe(false)
    await writeFile(join(h.repoDir, "README.md"), "edited\n")
    await expect(h.caller.paper.sync({ projectId, commit: true })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("Sync is off for this paper"),
    })
    expect((await git(h.repoDir, ["log", "--oneline"])).trim().split("\n")).toHaveLength(1)
  })

  test("sync links it with Sync on, and Sync does not commit build output", async () => {
    await git(h.repoDir, ["remote", "add", "origin", bare])
    await git(h.repoDir, ["fetch", "origin"])
    await git(h.repoDir, ["reset", "--hard", "origin/main"])
    await git(h.repoDir, ["branch", "--set-upstream-to", "origin/main"])
    const state = await h.caller.paper.link({ projectId, dir: h.repoDir, rootChoice: "sync" })
    expect(state.paper?.syncEnabled).toBe(true)
    await mkdir(join(h.repoDir, "build"), { recursive: true })
    await writeFile(join(h.repoDir, "build", "main.aux"), "aux\n")
    await writeFile(join(h.repoDir, "main.tex"), "\\documentclass{article}\nedited\n")
    expect(await h.caller.paper.sync({ projectId, commit: false })).toEqual({
      state: "needs-commit",
      changedFiles: ["main.tex"],
    })
    expect((await h.caller.paper.sync({ projectId, commit: true })).state).toBe("synced")
    expect(await remoteMainTex()).toContain("edited")
    expect(await remoteFiles()).not.toContain("build/main.aux")
  })
})

describe("a folder that is not a paper", { timeout: 30_000 }, () => {
  test("is refused, and the check lists the papers inside it with paths relative to it", async () => {
    const parent = join(h.dataDir, "papers")
    await mkdir(join(parent, "a"), { recursive: true })
    await writeFile(join(parent, "a", "main.tex"), "\\documentclass{article}\n")
    const clone = join(parent, "group", "b")
    await mkdir(clone, { recursive: true })
    await execFileAsync("git", ["init", "-b", "main", clone])
    await git(clone, ["remote", "add", "origin", OVERLEAF_ORIGIN])
    await mkdir(join(parent, "notes"))
    await writeFile(join(parent, "notes", "todo.txt"), "not a paper\n")
    for (const skipped of [".hidden", "node_modules", "build"]) {
      await mkdir(join(parent, skipped, "x"), { recursive: true })
      await writeFile(join(parent, skipped, "x", "main.tex"), "\\documentclass{article}\n")
    }
    await mkdir(join(parent, "1", "2", "3", "deep"), { recursive: true })
    await writeFile(join(parent, "1", "2", "3", "deep", "main.tex"), "\\documentclass{article}\n")
    await writeFile(join(parent, "README.md"), "many repos\n")

    expect(await h.caller.paper.checkFolder({ projectId, dir: parent })).toMatchObject({
      isPaper: false,
      inside: [
        { dir: join(parent, "a"), relPath: "a", overleaf: false },
        { dir: clone, relPath: "group/b", overleaf: true },
      ],
      stoppedEarly: false,
    })
    await expect(
      h.caller.paper.link({ projectId, dir: parent, rootChoice: null }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("not a paper folder"),
    })
    expect((await h.caller.paper.get({ projectId })).paper).toBeNull()
    // A folder found inside it can be used.
    const state = await h.caller.paper.link({ projectId, dir: join(parent, "a"), rootChoice: null })
    expect(state.paper?.dir).toBe(join(parent, "a"))
  })

  test("the project folder with no .tex file that is not an Overleaf clone is not a paper either", async () => {
    const check = await h.caller.paper.checkFolder({ projectId, dir: h.repoDir })
    expect(check).toMatchObject({ projectFolder: true, isPaper: false, inside: [] })
    for (const rootChoice of [null, "no-sync"] as const) {
      await expect(
        h.caller.paper.link({ projectId, dir: h.repoDir, rootChoice }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("not a paper folder"),
      })
    }
  })
})

/** Give the tests' global Git config a commit identity (creating a paper commits). */
async function useCommitIdentity(): Promise<void> {
  await execFileAsync("git", ["config", "--global", "user.email", "test@pi-lab.local"])
  await execFileAsync("git", ["config", "--global", "user.name", "PI Lab Test"])
}

/** A bare repo standing in for a Blank Overleaf project: one default main.tex on `master`. */
async function blankOverleafProject(): Promise<string> {
  const remote = join(h.dataDir, "blank.git")
  await execFileAsync("git", ["init", "--bare", "-b", "master", remote])
  const seed = join(h.dataDir, "blank-seed")
  await execFileAsync("git", ["init", "-b", "master", seed])
  await writeFile(join(seed, "main.tex"), "\\documentclass{article}\n% Overleaf blank\n")
  await git(seed, ["add", "."])
  await git(seed, ["commit", "-m", "blank"])
  await git(seed, ["push", remote, "master"])
  return remote
}

describe("create paper", () => {
  test("the default folder is <project>/paper, else the next free one: paper-2/, paper-3/, …", async () => {
    expect(await h.caller.paper.createTarget({ projectId })).toEqual({
      dir: join(h.repoDir, "paper"),
      displayDir: "paper",
    })
    // An empty paper/ is still used.
    await mkdir(join(h.repoDir, "paper"))
    expect((await h.caller.paper.createTarget({ projectId })).displayDir).toBe("paper")
    await writeFile(join(h.repoDir, "paper", "main.tex"), "x")
    expect(await h.caller.paper.createTarget({ projectId })).toEqual({
      dir: join(h.repoDir, "paper-2"),
      displayDir: "paper-2",
    })
    // An empty paper-2/ is used; once it has files, paper-3/ is proposed.
    await mkdir(join(h.repoDir, "paper-2"))
    expect((await h.caller.paper.createTarget({ projectId })).displayDir).toBe("paper-2")
    await writeFile(join(h.repoDir, "paper-2", "notes.txt"), "x")
    expect(await h.caller.paper.createTarget({ projectId })).toEqual({
      dir: join(h.repoDir, "paper-3"),
      displayDir: "paper-3",
    })
  })

  test("canCreateIn: true for an empty folder or a missing one whose parent exists, false for a folder with files", async () => {
    const empty = join(h.dataDir, "empty")
    await mkdir(empty)
    expect(await h.caller.paper.canCreateIn({ dir: empty })).toBe(true)
    expect(await h.caller.paper.canCreateIn({ dir: join(h.dataDir, "new") })).toBe(true)
    await writeFile(join(empty, "notes.txt"), "x")
    expect(await h.caller.paper.canCreateIn({ dir: empty })).toBe(false)
    expect(await h.caller.paper.canCreateIn({ dir: join(h.dataDir, "missing", "x") })).toBe(false)
  })

  test("creates the paper from the built-in template, with its own Git repo, hidden from the project repo", async () => {
    await useCommitIdentity()
    const dir = join(h.repoDir, "paper")
    const state = await h.caller.paper.create({ projectId, dir })
    expect(state.paper?.displayDir).toBe("paper")
    expect(state.paper?.remoteUrl).toBeNull()
    expect(state.rootRelPath).toBe("main.tex")
    expect(await readFile(join(dir, "main.tex"), "utf8")).toContain("\\usepackage{style}")
    expect((await git(dir, ["rev-parse", "--show-toplevel"])).trim()).toBe(dir)
    expect((await git(dir, ["ls-files"])).trim().split("\n").sort()).toEqual([
      "main.tex",
      "references.bib",
      "style.sty",
    ])
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("")
    expect((await git(h.repoDir, ["status", "--porcelain"])).trim()).toBe("")
    // Sync has nothing to sync with until it is connected to Overleaf.
    expect(await h.caller.paper.sync({ projectId, commit: true })).toEqual({ state: "no-remote" })
  })

  test("uses the template set in Settings, and works in a folder outside the project", async () => {
    await useCommitIdentity()
    const source = join(h.dataDir, "my-template")
    await mkdir(source)
    await writeFile(join(source, "thesis.tex"), "\\documentclass{report}\n")
    expect((await h.caller.paper.template.set({ dir: source })).custom?.files).toEqual([
      "thesis.tex",
    ])
    const dir = join(h.dataDir, "new-paper")
    const state = await h.caller.paper.create({ projectId, dir })
    expect(state.rootRelPath).toBe("thesis.tex")
    expect(existsSync(join(dir, "main.tex"))).toBe(false)
    expect((await h.caller.paper.template.clear()).custom).toBeNull()
  })

  test("refuses a folder with files in it, or whose parent folder is missing", async () => {
    const full = join(h.dataDir, "full")
    await mkdir(full)
    await writeFile(join(full, "notes.txt"), "x")
    await expect(h.caller.paper.create({ projectId, dir: full })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: `Choose an empty folder for the new paper: ${full} has files in it.`,
    })
    await expect(
      h.caller.paper.create({ projectId, dir: join(h.dataDir, "missing", "paper") }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect((await h.caller.paper.get({ projectId })).paper).toBeNull()
  })
})

describe("connect to Overleaf", { timeout: 30_000 }, () => {
  test("accepts only git.overleaf.com URLs, and refuses a paper that already has a remote", async () => {
    await expect(
      h.caller.paper.connectOverleaf({ projectId, url: "https://github.com/u/p.git" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await linkOutsideClone()
    await h.caller.paper.token.set({ token: "olp_secret" })
    await expect(
      h.caller.paper.connectOverleaf({ projectId, url: "https://git@git.overleaf.com/abc" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  test("merges a blank Overleaf project, keeps the local files, pushes, and Sync works after", async () => {
    await useCommitIdentity()
    const dir = join(h.repoDir, "paper")
    await h.caller.paper.create({ projectId, dir })
    // An edit not committed yet is sent too.
    const local = `${await readFile(join(dir, "main.tex"), "utf8")}% my edit\n`
    await writeFile(join(dir, "main.tex"), local)
    const blank = await blankOverleafProject()
    const result = await connectRemote(h.db, projectId, blank, { env: null })
    expect(result.state).toBe("synced")
    expect(await git(blank, ["show", "master:main.tex"])).toBe(local)
    expect((await git(blank, ["ls-tree", "--name-only", "master"])).trim().split("\n")).toEqual([
      "main.tex",
      "references.bib",
      "style.sty",
    ])
    expect((await h.caller.paper.get({ projectId })).paper?.remoteUrl).toBe(blank)
    await writeFile(join(dir, "references.bib"), "@misc{b}\n")
    expect((await h.caller.paper.sync({ projectId, commit: true })).state).toBe("synced")
    expect(await git(blank, ["show", "master:references.bib"])).toBe("@misc{b}\n")
  })

  test("an empty remote with no branch gets the local branch", async () => {
    await useCommitIdentity()
    const dir = join(h.dataDir, "fresh-paper")
    await h.caller.paper.create({ projectId, dir })
    const empty = join(h.dataDir, "empty.git")
    await execFileAsync("git", ["init", "--bare", empty])
    const branch = (await git(dir, ["symbolic-ref", "--short", "HEAD"])).trim()
    expect((await connectRemote(h.db, projectId, empty, { env: null })).state).toBe("synced")
    expect(await git(empty, ["show", `${branch}:main.tex`])).toContain("\\usepackage{style}")
  })

  test("only the local files end up on Overleaf, even when the local root is not main.tex", async () => {
    await useCommitIdentity()
    const source = join(h.dataDir, "my-template")
    await mkdir(source)
    await writeFile(join(source, "thesis.tex"), "\\documentclass{report}\n")
    await h.caller.paper.template.set({ dir: source })
    await h.caller.paper.create({ projectId, dir: join(h.repoDir, "paper") })
    const blank = await blankOverleafProject()
    expect((await connectRemote(h.db, projectId, blank, { env: null })).state).toBe("synced")
    expect((await git(blank, ["ls-tree", "--name-only", "master"])).trim()).toBe("thesis.tex")
  })

  test("a rejected push leaves the paper unconnected, so Connect can be tried again", async () => {
    await useCommitIdentity()
    await h.caller.paper.create({ projectId, dir: join(h.repoDir, "paper") })
    const blank = await blankOverleafProject()
    const hook = join(blank, "hooks", "pre-receive")
    await writeFile(hook, "#!/bin/sh\necho rejected by test >&2\nexit 1\n")
    await chmod(hook, 0o755)
    await expect(connectRemote(h.db, projectId, blank, { env: null })).rejects.toThrow()
    expect((await h.caller.paper.get({ projectId })).paper?.remoteUrl).toBeNull()
    expect((await git(join(h.repoDir, "paper"), ["remote"])).trim()).toBe("")
    await rm(hook)
    expect((await connectRemote(h.db, projectId, blank, { env: null })).state).toBe("synced")
  })
})
