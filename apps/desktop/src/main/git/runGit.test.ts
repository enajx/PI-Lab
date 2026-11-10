// Tests for the git wrapper's error text, run against the real git CLI.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { GitError, runGit } from "./runGit"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-lab-rungit-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test("a GitError never shows credentials embedded in a URL", async () => {
  const error = await runGit(
    dir,
    ["remote", "add", "origin", "https://git:olp_secret@git.overleaf.com/abc"],
    {},
  ).then(
    () => null,
    (cause: unknown) => cause,
  )
  expect(error).toBeInstanceOf(GitError)
  const gitError = error as GitError
  expect(gitError.message).toContain("https://git.overleaf.com/abc")
  expect(gitError.message).not.toContain("olp_secret")
  expect(gitError.args.join(" ")).not.toContain("olp_secret")
  const other = new GitError(["clone", "https://olp_secret@git.overleaf.com/abc"], 128, "fatal")
  expect(other.message).toBe("git clone https://git.overleaf.com/abc: fatal")
})
