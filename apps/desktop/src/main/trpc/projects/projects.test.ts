// Integration tests for the projects router via createCallerFactory over a temp
// SQLite DB with real migrations and a real temp git repo (md/engineering/testing-and-build.md).
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
import { projects } from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { isGitRepo } from "../../git"
import { createHarness, type Harness } from "../testHarness"

const execFileAsync = promisify(execFile)

/**
 * A self-contained git identity for `createFromTemplate`'s seed commit so the
 * suite is hermetic — it never reads (or needs) a global `git config user.*`,
 * which CI does not set (md/engineering/testing-and-build.md).
 */
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "PI Lab Test",
  GIT_AUTHOR_EMAIL: "test@pi-lab.local",
  GIT_COMMITTER_NAME: "PI Lab Test",
  GIT_COMMITTER_EMAIL: "test@pi-lab.local",
}

/**
 * Build a throwaway source repo with one commit and return its canonical path, to
 * clone from. `name` controls the repo's directory basename (so a test can give it
 * a conventional `.git` suffix); it lands inside a fresh temp parent.
 */
async function makeSourceRepo(name = "source"): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "pi-lab-src-")))
  const dir = join(parent, name)
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@pi-lab.local"])
  await run(["config", "user.name", "PI Lab Test"])
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
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-lab-tpl-src-")))
  await writeFile(join(dir, "README.md"), "# template\n")
  await writeFile(join(dir, ".gitignore"), ".DS_Store\n")
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

  test("opens a non-Git folder as a project and reports Git capabilities separately", async () => {
    const plain = await mkdtemp(join(tmpdir(), "pi-lab-plain-"))
    await writeFile(join(plain, "notes.md"), "# Plain folder\n")

    const project = await h.caller.projects.open({ path: plain })

    expect(project.repoPath).toBe(await realpath(plain))
    expect(project.name).toBe(basename(plain))
    expect(project.defaultBranch).toBeNull()
    expect(await h.caller.projects.capabilities({ id: project.id })).toEqual({ git: false })
    expect(await readFile(join(project.repoPath, "notes.md"), "utf8")).toBe("# Plain folder\n")
  })

  test("initializes Git explicitly, preserves existing files, and immediately supports worktrees", async () => {
    const plain = await mkdtemp(join(tmpdir(), "pi-lab-plain-"))
    await writeFile(join(plain, "notes.md"), "# Existing notes\n")
    const project = await h.caller.projects.open({ path: plain })

    const initialized = await h.caller.projects.initializeGit({ id: project.id })

    expect(initialized.defaultBranch).toBe("main")
    expect(await isGitRepo(project.repoPath)).toBe(true)
    expect(await h.caller.projects.capabilities({ id: project.id })).toEqual({ git: true })
    expect(await readFile(join(plain, "notes.md"), "utf8")).toBe("# Existing notes\n")
    const { stdout: status } = await execFileAsync("git", ["-C", plain, "status", "--porcelain"])
    expect(status.trim()).toBe("?? notes.md")

    const created = await h.caller.workspaces.create({
      projectId: project.id,
      kind: "worktree",
      name: "first-worktree",
    })
    expect(created.workspace.kind).toBe("worktree")
    expect(created.worktree).not.toBeNull()
    await h.caller.workspaces.remove({ id: created.workspace.id })
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
    const parentDir = await mkdtemp(join(tmpdir(), "pi-lab-clones-"))

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
    const parentDir = await mkdtemp(join(tmpdir(), "pi-lab-clones-"))

    const project = await h.caller.projects.clone({ url: source, parentDir })
    expect(project.name).toBe("study")
    expect(project.repoPath).toBe(await realpath(join(parentDir, "study")))
  })

  test("refuses to clobber an existing target directory", async () => {
    const source = await makeSourceRepo()
    const parentDir = await mkdtemp(join(tmpdir(), "pi-lab-clones-"))
    await h.caller.projects.clone({ url: source, parentDir })

    await expect(h.caller.projects.clone({ url: source, parentDir })).rejects.toMatchObject({
      code: "CONFLICT",
    })
    // Still exactly one project — the second attempt didn't open a duplicate.
    expect(await h.caller.projects.list()).toHaveLength(1)
  })

  test("a bad remote is a clean BAD_REQUEST", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "pi-lab-clones-"))
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
    const parent = await mkdtemp(join(tmpdir(), "pi-lab-tpl-"))
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
    const targetDir = await mkdtemp(join(tmpdir(), "pi-lab-tpl-"))

    const project = await h.caller.projects.createFromTemplate({ targetDir, templateDir })
    expect(await isGitRepo(project.repoPath)).toBe(true)
    expect(await readFile(join(project.repoPath, "README.md"), "utf8")).toBe("# template\n")
  })

  test("copies only the selected template and external initialization files", async () => {
    const templateDir = await makeTemplate()
    const parent = await mkdtemp(join(tmpdir(), "pi-lab-tpl-"))
    const targetDir = join(parent, "study")
    const externalFile = join(parent, "LOCAL_NOTES.txt")
    await writeFile(externalFile, "local notes\n")

    const project = await h.caller.projects.createFromTemplate({
      targetDir,
      templateDir,
      templateFiles: [".gitignore"],
      externalFiles: [externalFile],
    })

    expect(await readFile(join(project.repoPath, ".gitignore"), "utf8")).toBe(".DS_Store\n")
    expect(await readFile(join(project.repoPath, "LOCAL_NOTES.txt"), "utf8")).toBe("local notes\n")
    expect(await exists(join(project.repoPath, "AGENTS.md"))).toBe(false)
    expect(await exists(join(project.repoPath, "README.md"))).toBe(false)
    expect(await exists(join(project.repoPath, "docs", "guide.md"))).toBe(false)
  })

  test("refuses to clobber a non-empty target", async () => {
    const templateDir = await makeTemplate()
    const targetDir = await mkdtemp(join(tmpdir(), "pi-lab-tpl-"))
    await writeFile(join(targetDir, "keep.txt"), "do not overwrite me")

    await expect(
      h.caller.projects.createFromTemplate({ targetDir, templateDir }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await h.caller.projects.list()).toHaveLength(0)
  })

  test("a missing template directory is a clean NOT_FOUND", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-lab-tpl-"))

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

    const parent = await mkdtemp(join(tmpdir(), "pi-lab-tpl-"))
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

  test("setArchived hides and restores a project without removing it from list or get", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })

    const hidden = await h.caller.projects.setArchived({ id: project.id, archived: true })
    expect(hidden.archivedAt).toEqual(expect.any(Number))
    expect((await h.caller.projects.get({ id: project.id })).archivedAt).toBe(hidden.archivedAt)
    expect((await h.caller.projects.list()).map((row) => row.id)).toContain(project.id)

    const restored = await h.caller.projects.setArchived({ id: project.id, archived: false })
    expect(restored.archivedAt).toBeNull()
    expect((await h.caller.projects.list()).map((row) => row.id)).toContain(project.id)
  })

  test("setArchived throws NOT_FOUND for an unknown project", async () => {
    await expect(
      h.caller.projects.setArchived({ id: "missing", archived: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  test("remove forgets the project", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await h.caller.projects.remove({ id: project.id })
    expect(await h.caller.projects.list()).toHaveLength(0)
  })
})

describe("projects.setThumbnail", () => {
  const DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA="

  test("keeps thumbnail bytes out of lists and serves card and badge separately", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    expect(project.thumbnail).toBeNull()

    const updated = await h.caller.projects.setThumbnail({ id: project.id, dataUrl: DATA_URL })
    expect(updated.thumbnail).toBe(DATA_URL)

    expect((await h.caller.projects.get({ id: project.id })).thumbnail).toBe(DATA_URL)
    const listed = (await h.caller.projects.list()).find((p) => p.id === project.id)
    expect(listed?.hasThumbnail).toBe(true)
    expect(listed).not.toHaveProperty("thumbnail")
    expect(await h.caller.projects.thumbnail({ id: project.id, variant: "card" })).toEqual({
      dataUrl: DATA_URL,
      tooLarge: false,
    })
    const badge = await h.caller.projects.thumbnail({ id: project.id, variant: "badge" })
    expect(badge.dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(badge.tooLarge).toBe(false)
  })

  test("rejects an oversized GIF and keeps prior artwork", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await h.caller.projects.setThumbnail({ id: project.id, dataUrl: DATA_URL })
    const gif = Buffer.alloc(1_000_001)
    gif.write("GIF89a", 0, "ascii")
    gif.writeUInt16LE(1, 6)
    gif.writeUInt16LE(1, 8)
    const oversizedGif = `data:image/gif;base64,${gif.toString("base64")}`
    await expect(
      h.caller.projects.setThumbnail({ id: project.id, dataUrl: oversizedGif }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect((await h.caller.projects.get({ id: project.id })).thumbnail).toBe(DATA_URL)
  })

  test("accepts a GIF at exactly 1,000,000 decoded bytes", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const gif = Buffer.alloc(1_000_000)
    gif.write("GIF89a", 0, "ascii")
    gif.writeUInt16LE(1, 6)
    gif.writeUInt16LE(1, 8)
    const dataUrl = `data:image/gif;base64,${gif.toString("base64")}`
    await h.caller.projects.setThumbnail({ id: project.id, dataUrl })
    expect(await h.caller.projects.thumbnail({ id: project.id, variant: "card" })).toEqual({
      dataUrl,
      tooLarge: false,
    })
  })

  test("an old oversized row has a visible fallback and can be cleared", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const oldDataUrl = `data:image/png;base64,${Buffer.alloc(1_000_001).toString("base64")}`
    h.db.update(projects).set({ thumbnail: oldDataUrl }).where(eq(projects.id, project.id)).run()
    const listed = (await h.caller.projects.list()).find((row) => row.id === project.id)
    expect(listed?.hasThumbnail).toBe(true)
    expect(listed).not.toHaveProperty("thumbnail")
    expect(await h.caller.projects.thumbnail({ id: project.id, variant: "card" })).toEqual({
      dataUrl: null,
      tooLarge: true,
    })
    await h.caller.projects.setThumbnail({ id: project.id, dataUrl: null })
    expect(
      (await h.caller.projects.list()).find((row) => row.id === project.id)?.hasThumbnail,
    ).toBe(false)
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

  test("rejects a truncated PNG as BAD_REQUEST before decoding", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await expect(
      h.caller.projects.setThumbnail({
        id: project.id,
        dataUrl: `data:image/png;base64,${Buffer.from("89504e470d0a1a0a", "hex").toString("base64")}`,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
  })

  test("throws NOT_FOUND for an unknown project", async () => {
    await expect(
      h.caller.projects.setThumbnail({ id: "missing", dataUrl: DATA_URL }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  test("setting a thumbnail clears any stored gradient (one artwork at a time)", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await h.caller.projects.setGradient({
      id: project.id,
      gradient: { seed: 7, palette: ["#FFC700"] },
    })

    const updated = await h.caller.projects.setThumbnail({ id: project.id, dataUrl: DATA_URL })
    expect(updated.thumbnail).toBe(DATA_URL)
    expect(updated.gradient).toBeNull()
  })

  test("setting a thumbnail replaces Digital Rain", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await h.caller.projects.setDigitalRain({ id: project.id, enabled: true })

    const updated = await h.caller.projects.setThumbnail({ id: project.id, dataUrl: DATA_URL })
    expect(updated.digitalRain).toBe(false)
  })
})

describe("projects.setGradient", () => {
  test("persists a { seed, palette } gradient and surfaces it in list/get", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    expect(project.gradient).toBeNull()

    const gradient = { seed: 12345, palette: ["#FFC700", "#18A0FB"] }
    const updated = await h.caller.projects.setGradient({ id: project.id, gradient })
    expect(updated.gradient).toEqual(gradient)

    expect((await h.caller.projects.get({ id: project.id })).gradient).toEqual(gradient)
    const listed = (await h.caller.projects.list()).find((p) => p.id === project.id)
    expect(listed?.gradient).toEqual(gradient)
  })

  test("generating a gradient clears any thumbnail", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await h.caller.projects.setThumbnail({
      id: project.id,
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA=",
    })

    const updated = await h.caller.projects.setGradient({
      id: project.id,
      gradient: { seed: 1, palette: ["#EE46D3"] },
    })
    expect(updated.gradient).toEqual({ seed: 1, palette: ["#EE46D3"] })
    expect(updated.thumbnail).toBeNull()
  })

  test("generating a gradient replaces Digital Rain", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await h.caller.projects.setDigitalRain({ id: project.id, enabled: true })

    const updated = await h.caller.projects.setGradient({
      id: project.id,
      gradient: { seed: 1, palette: ["#EE46D3"] },
    })
    expect(updated.digitalRain).toBe(false)
  })

  test("clears the gradient with gradient: null", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await h.caller.projects.setGradient({
      id: project.id,
      gradient: { seed: 3, palette: ["#000"] },
    })

    const cleared = await h.caller.projects.setGradient({ id: project.id, gradient: null })
    expect(cleared.gradient).toBeNull()
  })

  test("throws NOT_FOUND for an unknown project", async () => {
    await expect(
      h.caller.projects.setGradient({ id: "missing", gradient: { seed: 1, palette: ["#000"] } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("projects Digital Rain", () => {
  test("persists Digital Rain as the sole card artwork", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await h.caller.projects.setThumbnail({
      id: project.id,
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA=",
    })

    const updated = await h.caller.projects.setDigitalRain({ id: project.id, enabled: true })
    expect(updated.digitalRain).toBe(true)
    expect(updated.thumbnail).toBeNull()
    expect(updated.gradient).toBeNull()
    expect((await h.caller.projects.get({ id: project.id })).digitalRain).toBe(true)
  })

  test("samples printable ASCII from small project text files and ignores build output", async () => {
    await writeFile(join(h.repoDir, "rain-source.ts"), "const RAIN_SOURCE = '<matrix>';\n")
    await mkdir(join(h.repoDir, "node_modules"))
    await writeFile(join(h.repoDir, "node_modules", "ignored.ts"), "IGNORE_ME")
    const project = await h.caller.projects.open({ path: h.repoDir })

    const sample = await h.caller.projects.digitalRainCharacters({ id: project.id })
    expect(sample.characters).toMatch(/^[!-~]+$/)
    expect(sample.characters).toContain("RAIN_SOURCE")
    expect(sample.characters).not.toContain("IGNORE_ME")
  })

  test("rejects character sampling for an unknown project", async () => {
    await expect(h.caller.projects.digitalRainCharacters({ id: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })
})

describe("projects.setMetadata", () => {
  const METADATA = {
    collaborators: "Ada Lovelace, Alan Turing",
    venue: "NeurIPS 2026",
    deadline: "2026-11-30",
    emojiTags: ["🔬", "🚀"],
    referenceLinks: [
      { url: "https://example.com/paper", label: "Preprint" },
      { url: "https://example.com/code" },
    ],
  }

  test("persists metadata and surfaces it in list/get", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    expect(project.metadata).toBeNull()

    const updated = await h.caller.projects.setMetadata({ id: project.id, metadata: METADATA })
    expect(updated.metadata).toEqual(METADATA)

    // Survives a fresh read (i.e. it round-trips through the DB, not just the return).
    expect((await h.caller.projects.get({ id: project.id })).metadata).toEqual(METADATA)
    const listed = (await h.caller.projects.list()).find((p) => p.id === project.id)
    expect(listed?.metadata).toEqual(METADATA)
  })

  test("clears metadata with metadata: null", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await h.caller.projects.setMetadata({ id: project.id, metadata: METADATA })

    const cleared = await h.caller.projects.setMetadata({ id: project.id, metadata: null })
    expect(cleared.metadata).toBeNull()
    expect((await h.caller.projects.get({ id: project.id })).metadata).toBeNull()
  })

  test("throws NOT_FOUND for an unknown project", async () => {
    await expect(
      h.caller.projects.setMetadata({ id: "missing", metadata: METADATA }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})
