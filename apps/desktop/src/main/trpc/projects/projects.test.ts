// Integration tests for the projects router via createCallerFactory over a temp
// SQLite DB with real migrations and a real temp git repo (docs/testing-and-build.md).
import { execFile } from "node:child_process"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { promisify } from "node:util"
import { TRPCError } from "@trpc/server"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { isGitRepo } from "../../git"
import { createHarness, type Harness } from "../testHarness"

const execFileAsync = promisify(execFile)

/**
 * A self-contained git identity for `createFromTemplate`'s seed commit so the
 * suite is hermetic — it never reads (or needs) a global `git config user.*`,
 * which CI does not set (docs/testing-and-build.md).
 */
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Skipper Test",
  GIT_AUTHOR_EMAIL: "test@skipper.local",
  GIT_COMMITTER_NAME: "Skipper Test",
  GIT_COMMITTER_EMAIL: "test@skipper.local",
}

/**
 * Build a throwaway source repo with one commit and return its canonical path, to
 * clone from. `name` controls the repo's directory basename (so a test can give it
 * a conventional `.git` suffix); it lands inside a fresh temp parent.
 */
async function makeSourceRepo(name = "source"): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "skipper-src-")))
  const dir = join(parent, name)
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@skipper.local"])
  await run(["config", "user.name", "Skipper Test"])
  await writeFile(join(dir, "README.md"), "# source\n")
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
  return dir
}

/**
 * Build a throwaway template directory to copy from: a couple of files, a nested
 * subdir, a symlink (CLAUDE.md -> AGENTS.md, to prove symlinks survive verbatim),
 * plus a `.DS_Store` and a fake `.git/` that `createFromTemplate` must skip.
 * Returns its canonical path.
 */
async function makeTemplate(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "skipper-tpl-src-")))
  await writeFile(join(dir, "README.md"), "# template\n")
  await writeFile(join(dir, "AGENTS.md"), "# agents\n")
  await symlink("AGENTS.md", join(dir, "CLAUDE.md"))
  await mkdir(join(dir, "docs"))
  await writeFile(join(dir, "docs", "guide.md"), "# guide\n")
  await writeFile(join(dir, ".DS_Store"), "junk")
  await mkdir(join(dir, ".git"))
  await writeFile(join(dir, ".git", "MARKER"), "must not be copied")
  return dir
}

/** Whether `path` exists on disk — to assert excluded entries are absent. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

let h: Harness

beforeEach(async () => {
  h = await createHarness()
  Object.assign(process.env, GIT_IDENTITY)
})

afterEach(async () => {
  for (const key of Object.keys(GIT_IDENTITY)) delete process.env[key]
  await h.dispose()
})

describe("projects.open", () => {
  test("opening a git repo stores name + default branch", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    expect(project.name).toBe("repo")
    expect(project.defaultBranch).toBe("main")
    expect(project.repoPath).toBe(h.repoDir)
  })

  test("a non-git directory is a clean BAD_REQUEST", async () => {
    const plain = await mkdtemp(join(tmpdir(), "skipper-plain-"))
    await expect(h.caller.projects.open({ path: plain })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
  })

  test("re-opening the same repo updates rather than duplicates", async () => {
    const first = await h.caller.projects.open({ path: h.repoDir })
    const again = await h.caller.projects.open({ path: h.repoDir })
    expect(again.id).toBe(first.id)
    const all = await h.caller.projects.list()
    expect(all).toHaveLength(1)
  })
})

describe("projects.clone", () => {
  test("clones a local source repo and stores the project", async () => {
    const source = await makeSourceRepo()
    const parentDir = await mkdtemp(join(tmpdir(), "skipper-clones-"))

    const project = await h.caller.projects.clone({ url: source, parentDir })

    // The folder name (hence the project name) is derived from the source URL.
    expect(project.name).toBe(basename(source))
    expect(project.repoPath).toBe(await realpath(join(parentDir, project.name)))
    expect(project.defaultBranch).toBe("main")
    expect(await isGitRepo(project.repoPath)).toBe(true)
    expect(await h.caller.projects.list()).toHaveLength(1)
  })

  test("derives the target folder from the URL, stripping a trailing .git", async () => {
    // A source whose directory name ends in `.git` (the conventional remote
    // form) so the derived folder name must have that suffix stripped.
    const source = await makeSourceRepo("study.git")
    const parentDir = await mkdtemp(join(tmpdir(), "skipper-clones-"))

    const project = await h.caller.projects.clone({ url: source, parentDir })
    expect(project.name).toBe("study")
    expect(project.repoPath).toBe(await realpath(join(parentDir, "study")))
  })

  test("refuses to clobber an existing target directory", async () => {
    const source = await makeSourceRepo()
    const parentDir = await mkdtemp(join(tmpdir(), "skipper-clones-"))
    await h.caller.projects.clone({ url: source, parentDir })

    await expect(h.caller.projects.clone({ url: source, parentDir })).rejects.toMatchObject({
      code: "CONFLICT",
    })
    // Still exactly one project — the second attempt didn't open a duplicate.
    expect(await h.caller.projects.list()).toHaveLength(1)
  })

  test("a bad remote is a clean BAD_REQUEST", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "skipper-clones-"))
    await expect(
      h.caller.projects.clone({
        url: join(parentDir, "does-not-exist-repo"),
        parentDir,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect(await h.caller.projects.list()).toHaveLength(0)
  })
})

describe("projects.createFromTemplate", () => {
  test("copies the template in, skips cruft, inits a repo, and stores the project", async () => {
    const templateDir = await makeTemplate()
    const parent = await mkdtemp(join(tmpdir(), "skipper-tpl-"))
    const targetDir = join(parent, "study")

    const project = await h.caller.projects.createFromTemplate({ targetDir, templateDir })

    // A real git repo with a default branch, registered as exactly one project.
    expect(project.defaultBranch).toBe("main")
    expect(project.repoPath).toBe(await realpath(targetDir))
    expect(await isGitRepo(project.repoPath)).toBe(true)
    expect(await h.caller.projects.list()).toHaveLength(1)

    const root = project.repoPath
    // Template contents copied, including a nested subdirectory.
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("# template\n")
    expect(await readFile(join(root, "docs", "guide.md"), "utf8")).toBe("# guide\n")

    // Symlinks survive verbatim (not dereferenced): CLAUDE.md -> AGENTS.md.
    expect((await lstat(join(root, "CLAUDE.md"))).isSymbolicLink()).toBe(true)
    expect(await readlink(join(root, "CLAUDE.md"))).toBe("AGENTS.md")

    // Editor/VCS cruft is filtered out: no `.DS_Store`, and the template's own
    // `.git` (with its marker) never lands — only our fresh init's repo is present.
    expect(await exists(join(root, ".DS_Store"))).toBe(false)
    expect(await exists(join(root, ".git", "MARKER"))).toBe(false)

    // The copy is committed, not left dangling in the working tree.
    const { stdout } = await execFileAsync("git", ["-C", root, "status", "--porcelain"])
    expect(stdout.trim()).toBe("")
  })

  test("accepts an existing empty target directory", async () => {
    const templateDir = await makeTemplate()
    // mkdtemp yields a real, empty directory — copying into it is allowed.
    const targetDir = await mkdtemp(join(tmpdir(), "skipper-tpl-"))

    const project = await h.caller.projects.createFromTemplate({ targetDir, templateDir })
    expect(await isGitRepo(project.repoPath)).toBe(true)
    expect(await readFile(join(project.repoPath, "README.md"), "utf8")).toBe("# template\n")
  })

  test("refuses to clobber a non-empty target", async () => {
    const templateDir = await makeTemplate()
    const targetDir = await mkdtemp(join(tmpdir(), "skipper-tpl-"))
    await writeFile(join(targetDir, "keep.txt"), "do not overwrite me")

    await expect(
      h.caller.projects.createFromTemplate({ targetDir, templateDir }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await h.caller.projects.list()).toHaveLength(0)
  })

  test("a missing template directory is a clean NOT_FOUND", async () => {
    const parent = await mkdtemp(join(tmpdir(), "skipper-tpl-"))

    await expect(
      h.caller.projects.createFromTemplate({
        targetDir: join(parent, "study"),
        templateDir: join(parent, "no-such-template"),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(await h.caller.projects.list()).toHaveLength(0)
  })

  test("with no templateDir, copies from the writable template under the data dir", async () => {
    // Pre-seed the writable template (`<dataDir>/template`) with a marker so the
    // default source is unambiguously what gets copied (the idempotent seed inside
    // createFromTemplate then leaves this edited copy untouched).
    const writable = join(h.dataDir, "template")
    await mkdir(writable, { recursive: true })
    await writeFile(join(writable, "MARKER.md"), "# from writable template\n")

    const parent = await mkdtemp(join(tmpdir(), "skipper-tpl-"))
    const targetDir = join(parent, "study")

    const project = await h.caller.projects.createFromTemplate({ targetDir })

    expect(await isGitRepo(project.repoPath)).toBe(true)
    expect(await readFile(join(project.repoPath, "MARKER.md"), "utf8")).toBe(
      "# from writable template\n",
    )
  })
})

describe("projects.list / get / touch / remove", () => {
  test("list returns opened projects", async () => {
    await h.caller.projects.open({ path: h.repoDir })
    const all = await h.caller.projects.list()
    expect(all.map((p) => p.repoPath)).toContain(h.repoDir)
  })

  test("get throws NOT_FOUND for an unknown id", async () => {
    await expect(h.caller.projects.get({ id: "missing" })).rejects.toBeInstanceOf(TRPCError)
  })

  test("touch bumps lastOpenedAt", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const touched = await h.caller.projects.touch({ id: project.id })
    expect(touched.lastOpenedAt).toBeGreaterThanOrEqual(project.lastOpenedAt)
  })

  test("remove forgets the project", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await h.caller.projects.remove({ id: project.id })
    expect(await h.caller.projects.list()).toHaveLength(0)
  })
})

describe("projects.setThumbnail", () => {
  const DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA="

  test("persists a data-URL thumbnail and surfaces it in list/get", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    expect(project.thumbnail).toBeNull()

    const updated = await h.caller.projects.setThumbnail({ id: project.id, dataUrl: DATA_URL })
    expect(updated.thumbnail).toBe(DATA_URL)

    expect((await h.caller.projects.get({ id: project.id })).thumbnail).toBe(DATA_URL)
    const listed = (await h.caller.projects.list()).find((p) => p.id === project.id)
    expect(listed?.thumbnail).toBe(DATA_URL)
  })

  test("clears the thumbnail with dataUrl: null", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await h.caller.projects.setThumbnail({ id: project.id, dataUrl: DATA_URL })

    const cleared = await h.caller.projects.setThumbnail({ id: project.id, dataUrl: null })
    expect(cleared.thumbnail).toBeNull()
    expect((await h.caller.projects.get({ id: project.id })).thumbnail).toBeNull()
  })

  test("rejects a non-data URL", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await expect(
      h.caller.projects.setThumbnail({ id: project.id, dataUrl: "https://example.com/x.png" }),
    ).rejects.toBeInstanceOf(TRPCError)
  })

  test("throws NOT_FOUND for an unknown project", async () => {
    await expect(
      h.caller.projects.setThumbnail({ id: "missing", dataUrl: DATA_URL }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})
