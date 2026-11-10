import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { GitError, runGit } from "./runGit"

/**
 * Git helpers for syncing a working copy with its remote: pull, push, commit
 * and merge-conflict inspection. Used by the LaTeX paper sync, which runs them
 * inside the linked paper folder only.
 */

/** Options for a call that talks to the remote. */
export interface RemoteCallOptions {
  /** Extra environment for git (for example the Overleaf askpass setup), or null for none. */
  env: Record<string, string> | null
}

/** Network calls can be slow on large projects; give them more time than local calls. */
const REMOTE_TIMEOUT_MS = 300_000

/** Build runGit options for a remote call, adding the env only when one is given. */
function remoteRunOptions(options: RemoteCallOptions): {
  timeoutMs: number
  env?: Record<string, string>
} {
  return options.env
    ? { timeoutMs: REMOTE_TIMEOUT_MS, env: options.env }
    : { timeoutMs: REMOTE_TIMEOUT_MS }
}

/** URL of the `origin` remote, or null when the repo has no `origin`. */
export async function remoteUrl(dir: string): Promise<string | null> {
  const { stdout } = await runGit(dir, ["remote"], {})
  if (!stdout.split("\n").some((name) => name.trim() === "origin")) return null
  const url = await runGit(dir, ["remote", "get-url", "origin"], {})
  return url.stdout.trim()
}

/** Push URL of the `origin` remote (equals the fetch URL unless a separate push URL is set). */
export async function pushUrl(dir: string): Promise<string> {
  const { stdout } = await runGit(dir, ["remote", "get-url", "--push", "origin"], {})
  return stdout.trim()
}

/** True while a merge is in progress (MERGE_HEAD exists). */
export async function isMerging(dir: string): Promise<boolean> {
  const { stdout } = await runGit(dir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
    allowFailure: true,
  })
  return stdout.trim().length > 0
}

/** Paths (relative to the repo root) that are still unmerged in the index. */
export async function conflictedFiles(dir: string): Promise<string[]> {
  const { stdout } = await runGit(dir, ["diff", "--name-only", "--diff-filter=U", "-z"], {})
  return stdout.split("\0").filter((path) => path.length > 0)
}

/** True when a line is one of Git's conflict markers. */
function isConflictMarker(line: string): boolean {
  return line.startsWith("<<<<<<< ") || line.startsWith("=======") || line.startsWith(">>>>>>> ")
}

/** Git treats a file as binary when its first 8000 bytes contain a NUL byte. */
const BINARY_CHECK_BYTES = 8000

/**
 * The subset of unmerged `files` (relative to `dir`) that are not resolved yet.
 * A file counts as resolved only when both merge sides have a version of it,
 * and it exists, is a text file, and has no conflict marker lines. A
 * modify/delete conflict, a missing file, or a binary file (a figure) always
 * stays unresolved, so it is settled only by an explicit choice.
 */
export async function unresolvedFiles(dir: string, files: string[]): Promise<string[]> {
  const stages = await conflictStages(dir)
  const unresolved: string[] = []
  for (const file of files) {
    const sides = stages.get(file)
    const path = join(dir, file)
    const oneSided = sides !== undefined && !(sides.ours && sides.theirs)
    if (oneSided || !existsSync(path) || !(await stat(path)).isFile()) {
      unresolved.push(file)
      continue
    }
    const bytes = await readFile(path)
    const binary = bytes.subarray(0, BINARY_CHECK_BYTES).includes(0)
    if (binary || bytes.toString("utf8").split(/\r?\n/).some(isConflictMarker)) {
      unresolved.push(file)
    }
  }
  return unresolved
}

/**
 * Unmerged files grouped by which merge sides have a version in the index
 * (`git ls-files -u`: stage 2 is ours, stage 3 is theirs).
 */
export async function conflictStages(
  dir: string,
): Promise<Map<string, { ours: boolean; theirs: boolean }>> {
  const { stdout } = await runGit(dir, ["ls-files", "-u", "-z"], {})
  const stages = new Map<string, { ours: boolean; theirs: boolean }>()
  for (const entry of stdout.split("\0")) {
    const tab = entry.indexOf("\t")
    if (tab < 0) continue
    const stage = entry.slice(0, tab).split(" ")[2]
    const path = entry.slice(tab + 1)
    const sides = stages.get(path) ?? { ours: false, theirs: false }
    if (stage === "2") sides.ours = true
    if (stage === "3") sides.theirs = true
    stages.set(path, sides)
  }
  return stages
}

/** Settle every unmerged file with one side's version, deleting files that side does not have. */
export async function takeSide(dir: string, side: "ours" | "theirs"): Promise<void> {
  for (const [path, sides] of await conflictStages(dir)) await takeSideOf(dir, side, path, sides)
}

/**
 * Settle one unmerged file `path` with one side's version, or delete it when
 * that side does not have it. `sides` is its entry from {@link conflictStages}.
 */
export async function takeSideOf(
  dir: string,
  side: "ours" | "theirs",
  path: string,
  sides: { ours: boolean; theirs: boolean },
): Promise<void> {
  if (sides[side]) {
    await runGit(dir, ["checkout", `--${side}`, "--", path], {})
    await runGit(dir, ["add", "--", path], {})
  } else {
    await runGit(dir, ["rm", "--quiet", "--", path], {})
  }
}

/**
 * What kind of conflict an unmerged file has: "text" when both sides have it
 * and it is a text file (the only kind an agent or the editor can merge),
 * "binary" when both sides have it but the file in the folder is binary (a
 * figure) or not there, and
 * "deleted-mine" / "deleted-overleaf" for a modify/delete conflict, by the
 * side ("ours" is mine) that deleted it.
 */
export type ConflictKind = "text" | "binary" | "deleted-mine" | "deleted-overleaf"

/** Every unmerged file in `dir` with its {@link ConflictKind}, sorted by path. */
export async function conflictKinds(
  dir: string,
): Promise<Array<{ relPath: string; kind: ConflictKind }>> {
  const result: Array<{ relPath: string; kind: ConflictKind }> = []
  for (const [relPath, sides] of await conflictStages(dir)) {
    result.push({ relPath, kind: await conflictKind(join(dir, relPath), sides) })
  }
  return result.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
}

/** The {@link ConflictKind} of the unmerged file at `path` with merge `sides`. */
async function conflictKind(
  path: string,
  sides: { ours: boolean; theirs: boolean },
): Promise<ConflictKind> {
  if (!sides.ours) return "deleted-mine"
  if (!sides.theirs) return "deleted-overleaf"
  if (!existsSync(path) || !(await stat(path)).isFile()) return "binary"
  const bytes = await readFile(path)
  return bytes.subarray(0, BINARY_CHECK_BYTES).includes(0) ? "binary" : "text"
}

/**
 * Merge the upstream branch into the current one (`pull --no-rebase --ff
 * --no-edit`; `--ff` overrides a user's `pull.ff=only`). Returns "conflict"
 * when the merge stopped on conflicts; any other failure (network, auth, no
 * upstream) is thrown as a {@link GitError}.
 */
export async function pull(
  dir: string,
  options: RemoteCallOptions,
): Promise<"merged" | "conflict"> {
  const args = ["pull", "--no-rebase", "--ff", "--no-edit"]
  const run = runGit(dir, args, remoteRunOptions(options)).then(
    () => "merged" as const,
    async (error: unknown) => {
      if (error instanceof GitError && (await isMerging(dir))) return "conflict" as const
      throw error
    },
  )
  return run
}

/** Push the current branch to its upstream. */
export async function push(dir: string, options: RemoteCallOptions): Promise<void> {
  await runGit(dir, ["push"], remoteRunOptions(options))
}

/**
 * Add a line to the repo's own `.git/info/exclude` (local, never committed)
 * unless it is already there. `dir` may be any folder inside the repo.
 */
export async function addLocalExclude(dir: string, pattern: string): Promise<void> {
  const { stdout } = await runGit(dir, ["rev-parse", "--git-path", "info/exclude"], {})
  const excludePath = resolve(dir, stdout.trim())
  await mkdir(dirname(excludePath), { recursive: true })
  const current = existsSync(excludePath) ? await readFile(excludePath, "utf8") : ""
  if (current.split(/\r?\n/).includes(pattern)) return
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : ""
  await appendFile(excludePath, `${prefix}${pattern}\n`)
}

/** Stage every change (including new and deleted files) and commit it with `message`. */
export async function commitAll(dir: string, message: string): Promise<void> {
  await runGit(dir, ["add", "-A"], {})
  await runGit(dir, ["commit", "-m", message], {})
}

/** Clone `url` into `targetDir`, running git from `parentDir`. */
export async function clone(
  parentDir: string,
  url: string,
  targetDir: string,
  options: RemoteCallOptions,
): Promise<void> {
  await runGit(parentDir, ["clone", url, targetDir], remoteRunOptions(options))
}

/**
 * The branch to connect to on `url`: the one its HEAD points at
 * (`git ls-remote --symref`), else its only branch when the server does not
 * say where HEAD points, or null when it has no branch yet. A remote with
 * several branches and no HEAD is refused, so PI Lab never guesses.
 */
export async function remoteDefaultBranch(
  dir: string,
  url: string,
  options: RemoteCallOptions,
): Promise<string | null> {
  const symref = await runGit(
    dir,
    ["ls-remote", "--symref", url, "HEAD"],
    remoteRunOptions(options),
  )
  const head = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(symref.stdout)?.[1]
  if (head) return head
  const heads = await runGit(dir, ["ls-remote", "--heads", url], remoteRunOptions(options))
  const branches = [...heads.stdout.matchAll(/\trefs\/heads\/(\S+)$/gm)].map((m) => m[1] ?? "")
  if (branches.length <= 1) return branches[0] ?? null
  throw new Error(
    `The remote has several branches and does not say which one is its main branch: ${branches.join(", ")}`,
  )
}

/**
 * Fetch `branch` from `url` and record it as merged into the current branch
 * although the histories are unrelated, keeping the local files exactly as
 * they are (`-s ours`): none of the remote's files are taken. Used to send a
 * local paper to a Blank Overleaf project, whose default files are replaced.
 */
export async function mergeUnrelatedKeepingOurs(
  dir: string,
  url: string,
  branch: string,
  message: string,
  options: RemoteCallOptions,
): Promise<void> {
  await runGit(dir, ["fetch", url, `refs/heads/${branch}`], remoteRunOptions(options))
  await runGit(
    dir,
    [
      "merge",
      "--allow-unrelated-histories",
      "--no-edit",
      "-s",
      "ours",
      "-m",
      message,
      "FETCH_HEAD",
    ],
    {},
  )
}

/** Name of the current branch. */
export async function currentBranch(dir: string): Promise<string> {
  const { stdout } = await runGit(dir, ["symbolic-ref", "--short", "HEAD"], {})
  return stdout.trim()
}

/** Push the current branch to `branch` on `origin` and make it the upstream. */
export async function pushSetUpstream(
  dir: string,
  branch: string,
  options: RemoteCallOptions,
): Promise<void> {
  await runGit(dir, ["push", "-u", "origin", `HEAD:${branch}`], remoteRunOptions(options))
}
