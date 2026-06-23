// Integration tests for the git wrapper against throwaway repos created with
// real `git init` (AGENTS.md §14). No mocks — these exercise the actual CLI.
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  addWorktree,
  branchExists,
  currentBranch,
  isGitRepo,
  removeWorktree,
  repoName,
  resolveDefaultBranch,
  status,
} from "./git"

const execFileAsync = promisify(execFile)

let root: string
let repoDir: string

/** Initialize a repo with one commit on `main`, deterministic identity. */
async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@skipper.local"])
  await run(["config", "user.name", "Skipper Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skipper-git-"))
  repoDir = join(root, "repo")
  await initRepo(repoDir)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("isGitRepo", () => {
  test("true inside a working tree", async () => {
    expect(await isGitRepo(repoDir)).toBe(true)
  })

  test("false for a plain directory", async () => {
    const plain = join(root, "not-a-repo")
    await mkdtemp(plain).catch(() => {})
    expect(await isGitRepo(root)).toBe(false)
  })
})

describe("repoName / branches", () => {
  test("repoName is the toplevel basename", async () => {
    expect(await repoName(repoDir)).toBe("repo")
  })

  test("currentBranch reflects the checked-out branch", async () => {
    expect(await currentBranch(repoDir)).toBe("main")
  })

  test("resolveDefaultBranch falls back to the current branch with no remote", async () => {
    expect(await resolveDefaultBranch(repoDir)).toBe("main")
  })

  test("branchExists distinguishes present from absent", async () => {
    expect(await branchExists(repoDir, "main")).toBe(true)
    expect(await branchExists(repoDir, "nope")).toBe(false)
  })
})

describe("worktrees", () => {
  test("addWorktree creates the checkout and a new branch; removeWorktree cleans up", async () => {
    const wtDir = join(root, "wt")
    await addWorktree(repoDir, wtDir, "feature/x", "main")

    expect(await isGitRepo(wtDir)).toBe(true)
    expect(await currentBranch(wtDir)).toBe("feature/x")
    expect(await branchExists(repoDir, "feature/x")).toBe(true)

    await removeWorktree(repoDir, wtDir)
    expect(await isGitRepo(wtDir)).toBe(false)
  })
})

describe("status", () => {
  test("clean tree is empty; new + staged files are reported", async () => {
    expect(await status(repoDir)).toEqual([])

    await writeFile(join(repoDir, "untracked.txt"), "hi\n")
    const dirty = await status(repoDir)
    expect(dirty.some((c) => c.path === "untracked.txt" && c.status === "untracked")).toBe(true)

    await execFileAsync("git", ["-C", repoDir, "add", "untracked.txt"])
    const staged = await status(repoDir)
    const entry = staged.find((c) => c.path === "untracked.txt")
    expect(entry?.status).toBe("added")
    expect(entry?.staged).toBe(true)
  })
})
