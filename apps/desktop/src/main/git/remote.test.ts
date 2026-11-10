// Integration tests for the pull/push/commit helpers used by the LaTeX paper
// sync. A local bare repo stands in for the Overleaf remote; two clones of it
// make a real merge conflict. No mocks: these run the real git CLI.
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  commitAll,
  conflictedFiles,
  isMerging,
  pull,
  push,
  pushUrl,
  remoteDefaultBranch,
  remoteUrl,
  unresolvedFiles,
} from "./remote"
import { runGit } from "./runGit"

const execFileAsync = promisify(execFile)
const NO_ENV = { env: null }

let root: string
let bare: string
let mine: string
let theirs: string

/** Run git in `dir` with the test identity, for fixture setup only. */
async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args])
  return stdout
}

/** Clone the bare remote into `dir` and give it a commit identity. */
async function cloneRemote(dir: string): Promise<void> {
  await execFileAsync("git", ["clone", bare, dir])
  await git(dir, ["config", "user.email", "test@pi-lab.local"])
  await git(dir, ["config", "user.name", "PI Lab Test"])
  await git(dir, ["config", "pull.rebase", "true"])
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-lab-remote-"))
  bare = join(root, "overleaf.git")
  await execFileAsync("git", ["init", "--bare", "-b", "main", bare])
  const seed = join(root, "seed")
  await execFileAsync("git", ["init", "-b", "main", seed])
  await git(seed, ["config", "user.email", "test@pi-lab.local"])
  await git(seed, ["config", "user.name", "PI Lab Test"])
  await writeFile(join(seed, "main.tex"), "\\documentclass{article}\nline one\n")
  await git(seed, ["add", "."])
  await git(seed, ["commit", "-m", "seed"])
  await git(seed, ["push", bare, "main"])
  mine = join(root, "mine")
  theirs = join(root, "theirs")
  await cloneRemote(mine)
  await cloneRemote(theirs)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("remote helpers", () => {
  test("commitAll + push send local edits; pull brings them into the other clone", async () => {
    await writeFile(join(mine, "new.tex"), "new\n")
    await commitAll(mine, "Sync from PI Lab")
    await push(mine, NO_ENV)
    expect(await pull(theirs, NO_ENV)).toBe("merged")
    expect(await readFile(join(theirs, "new.tex"), "utf8")).toBe("new\n")
    expect(await remoteUrl(mine)).toBe(bare)
    expect(await pushUrl(mine)).toBe(bare)
    await runGit(mine, ["remote", "set-url", "--push", "origin", "https://example.com/p.git"], {})
    expect(await remoteUrl(mine)).toBe(bare)
    expect(await pushUrl(mine)).toBe("https://example.com/p.git")
  })

  test("pull merges (no rebase, even with pull.rebase set) and reports a conflict", async () => {
    await writeFile(join(theirs, "main.tex"), "\\documentclass{article}\nfrom overleaf\n")
    await commitAll(theirs, "theirs")
    await push(theirs, NO_ENV)
    await writeFile(join(mine, "main.tex"), "\\documentclass{article}\nfrom pi lab\n")
    await commitAll(mine, "mine")

    expect(await pull(mine, NO_ENV)).toBe("conflict")
    expect(await isMerging(mine)).toBe(true)
    expect(await conflictedFiles(mine)).toEqual(["main.tex"])
    expect(await unresolvedFiles(mine, ["main.tex"])).toEqual(["main.tex"])

    await writeFile(join(mine, "main.tex"), "\\documentclass{article}\nresolved\n")
    expect(await unresolvedFiles(mine, ["main.tex"])).toEqual([])
    // A missing file or a binary file is never counted as resolved.
    await writeFile(join(mine, "figure.png"), "\0binary")
    expect(await unresolvedFiles(mine, ["gone.tex", "figure.png"])).toEqual([
      "gone.tex",
      "figure.png",
    ])
  })

  test("pull surfaces a non-conflict failure as an error", async () => {
    await runGit(mine, ["remote", "set-url", "origin", join(root, "missing.git")], {})
    await expect(pull(mine, NO_ENV)).rejects.toThrow()
    expect(await isMerging(mine)).toBe(false)
  })

  test("remoteUrl is null without an origin remote", async () => {
    await runGit(mine, ["remote", "remove", "origin"], {})
    expect(await remoteUrl(mine)).toBeNull()
  })
})

describe("remoteDefaultBranch", () => {
  test("uses HEAD's branch, else the only branch, else null; refuses several branches with no HEAD", async () => {
    const branch = (await git(bare, ["symbolic-ref", "--short", "HEAD"])).trim()
    expect(await remoteDefaultBranch(mine, bare, NO_ENV)).toBe(branch)
    // HEAD points at a branch that does not exist, so the server reports no HEAD.
    await git(bare, ["symbolic-ref", "HEAD", "refs/heads/missing"])
    expect(await remoteDefaultBranch(mine, bare, NO_ENV)).toBe(branch)
    await git(bare, ["branch", "second", branch])
    await expect(remoteDefaultBranch(mine, bare, NO_ENV)).rejects.toThrow("several branches")
    const empty = join(root, "empty.git")
    await execFileAsync("git", ["init", "--bare", empty])
    expect(await remoteDefaultBranch(mine, empty, NO_ENV)).toBeNull()
  })
})
