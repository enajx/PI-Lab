// Integration tests for papers added in the LaTeX Editor with no project (a
// "paper-only project"), through the tRPC caller over a real SQLite DB and the
// real git CLI. A local bare repo stands in for Overleaf: Git's `insteadOf`
// (in a test global config) sends a git.overleaf.com URL to it.
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createHarness, type Harness } from "../testHarness"

const execFileAsync = promisify(execFile)

let h: Harness
let bare: string

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args])
  return stdout
}

/** A bare repo holding a one-file paper, standing in for an Overleaf project. */
async function seedRemote(root: string): Promise<string> {
  const remote = join(root, "overleaf.git")
  await execFileAsync("git", ["init", "--bare", "-b", "main", remote])
  const seed = join(root, "seed")
  await execFileAsync("git", ["init", "-b", "main", seed])
  await writeFile(join(seed, "main.tex"), "\\documentclass{article}\n\\section{Intro}\n")
  await git(seed, ["add", "."])
  await git(seed, ["commit", "-m", "seed"])
  await git(seed, ["push", remote, "main"])
  return remote
}

const GIT_ENV_KEYS = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const
let previousGitEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  h = await createHarness([], { daemon: "lazy" })
  previousGitEnv = Object.fromEntries(GIT_ENV_KEYS.map((key) => [key, process.env[key]]))
  process.env.GIT_CONFIG_GLOBAL = join(h.dataDir, "test-gitconfig")
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  await execFileAsync("git", ["config", "--global", "user.email", "test@pi-lab.local"])
  await execFileAsync("git", ["config", "--global", "user.name", "PI Lab Test"])
  bare = await seedRemote(h.dataDir)
  await h.caller.settings.updateEditor({ papersFolder: join(h.dataDir, "Papers") })
})

afterEach(async () => {
  for (const key of GIT_ENV_KEYS) {
    const value = previousGitEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await h.dispose()
})

/** The project row for `id` as `projects.list` returns it. */
async function listed(id: string) {
  return (await h.caller.projects.list()).find((project) => project.id === id)
}

describe("paper with no project", { timeout: 30_000 }, () => {
  test("an existing paper folder becomes a paper-only project whose paper is that folder, with Sync on", async () => {
    const dir = join(h.dataDir, "my-paper")
    await execFileAsync("git", ["clone", bare, dir])
    const { projectId } = await h.caller.paper.addStandalone({ source: "folder", dir })
    const project = await listed(projectId)
    expect(project?.repoPath).toBe(dir)
    expect(project?.name).toBe("my-paper")
    expect(project?.metadata?.paperOnly).toBe(true)
    const state = await h.caller.paper.get({ projectId })
    expect(state.paper?.dir).toBe(dir)
    expect(state.paper?.syncEnabled).toBe(true)
    expect(state.rootRelPath).toBe("main.tex")
  })

  test("a folder already in PI Lab is refused and nothing is added", async () => {
    const dir = join(h.dataDir, "my-paper")
    await execFileAsync("git", ["clone", bare, dir])
    await h.caller.paper.addStandalone({ source: "folder", dir })
    await expect(h.caller.paper.addStandalone({ source: "folder", dir })).rejects.toThrow(
      '"my-paper" is already in PI Lab.',
    )
    expect(await h.caller.projects.list()).toHaveLength(1)
  })

  test("a folder that is not a paper is refused and nothing is added", async () => {
    const dir = join(h.dataDir, "not-a-paper")
    await mkdir(dir)
    await writeFile(join(dir, "notes.txt"), "x")
    await expect(h.caller.paper.addStandalone({ source: "folder", dir })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    expect(await h.caller.projects.list()).toHaveLength(0)
  })

  test("Start draft creates the folder and its missing parents from the template", async () => {
    const dir = join(h.dataDir, "Papers", "paper")
    const { projectId } = await h.caller.paper.addStandalone({ source: "draft", dir })
    expect(await readFile(join(dir, "main.tex"), "utf8")).toContain("\\documentclass")
    expect((await listed(projectId))?.metadata?.paperOnly).toBe(true)
    expect((await h.caller.paper.get({ projectId })).paper?.dir).toBe(dir)
  })

  test("Add Overleaf project clones into the chosen folder; a failed clone leaves no project or folder", async () => {
    await execFileAsync("git", [
      "config",
      "--global",
      `url.${join(h.dataDir, "missing.git")}.insteadOf`,
      "https://git@git.overleaf.com/bad",
    ])
    await execFileAsync("git", [
      "config",
      "--global",
      `url.${bare}.insteadOf`,
      "https://git@git.overleaf.com/good",
    ])
    const failed = join(h.dataDir, "Papers", "bad")
    await expect(
      h.caller.paper.addStandalone({
        source: "overleaf",
        url: "https://git@git.overleaf.com/bad",
        token: "olp_x",
        dir: failed,
      }),
    ).rejects.toThrow("does not appear to be a git repository")
    expect(await h.caller.projects.list()).toHaveLength(0)
    expect(existsSync(failed)).toBe(false)

    const dir = join(h.dataDir, "Papers", "good")
    const { projectId } = await h.caller.paper.addStandalone({
      source: "overleaf",
      url: "https://git@git.overleaf.com/good",
      token: "olp_x",
      dir,
    })
    const state = await h.caller.paper.get({ projectId })
    expect(state.paper?.dir).toBe(dir)
    // Git reports the stand-in path the test config sends the URL to.
    expect(state.paper?.remoteUrl).toBe(bare)
    expect(await readFile(join(dir, "main.tex"), "utf8")).toContain("Intro")
  })

  test("standaloneTarget proposes <papers folder>/paper, then paper-2, and the Overleaf id for a URL", async () => {
    const papers = join(h.dataDir, "Papers")
    expect(await h.caller.paper.standaloneTarget({ url: null })).toEqual({
      dir: join(papers, "paper"),
    })
    await mkdir(join(papers, "paper"), { recursive: true })
    await writeFile(join(papers, "paper", "main.tex"), "x")
    expect(await h.caller.paper.standaloneTarget({ url: null })).toEqual({
      dir: join(papers, "paper-2"),
    })
    expect(
      await h.caller.paper.standaloneTarget({ url: "https://git@git.overleaf.com/abc123" }),
    ).toEqual({ dir: join(papers, "abc123") })
  })

  test("linking to a project moves the paper there and removes the paper-only project", async () => {
    const dir = join(h.dataDir, "my-paper")
    await execFileAsync("git", ["clone", bare, dir])
    const { projectId: paperId } = await h.caller.paper.addStandalone({ source: "folder", dir })
    const projectId = (await h.caller.projects.open({ path: h.repoDir })).id
    // Only a paper-only project can be moved.
    await expect(
      h.caller.paper.moveToProject({ fromProjectId: projectId, toProjectId: paperId }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    const state = await h.caller.paper.moveToProject({
      fromProjectId: paperId,
      toProjectId: projectId,
    })
    expect(state.paper?.dir).toBe(dir)
    expect((await h.caller.projects.list()).map((project) => project.id)).toEqual([projectId])
    expect(existsSync(join(dir, "main.tex"))).toBe(true)
  })

  test("linking to a project that already has a paper is refused", async () => {
    const dir = join(h.dataDir, "my-paper")
    await execFileAsync("git", ["clone", bare, dir])
    const other = join(h.dataDir, "other-paper")
    await execFileAsync("git", ["clone", bare, other])
    const { projectId: paperId } = await h.caller.paper.addStandalone({ source: "folder", dir })
    const projectId = (await h.caller.projects.open({ path: h.repoDir })).id
    await h.caller.paper.link({ projectId, dir: other, rootChoice: null })
    await expect(
      h.caller.paper.moveToProject({ fromProjectId: paperId, toProjectId: projectId }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await h.caller.projects.list()).toHaveLength(2)
  })
})
