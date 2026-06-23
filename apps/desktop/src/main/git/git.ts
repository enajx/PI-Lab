import { basename } from "node:path"
import { type GitChange, parseStatusV2 } from "./parseStatus"
import { GitError, runGit } from "./runGit"

/**
 * Skipper's git operations, expressed as promisified calls to the user's own
 * `git` CLI (no new dependency — AGENTS.md §5/§6). Each function is total and
 * typed; git failures surface as {@link GitError} with git's own stderr. These
 * back the projects/workspaces routers (repo validation, worktree management,
 * the changes pane) and nothing here touches the DB or tRPC.
 */

export type { ChangeStatus, GitChange } from "./parseStatus"
export { GitError } from "./runGit"

/**
 * Whether `dir` is inside a git working tree. Uses
 * `git rev-parse --is-inside-work-tree`, which returns "true" only for a real
 * checkout (not a bare repo or a non-repo path). Never throws: a non-repo path
 * is a normal, expected answer, returned as `false`.
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(dir, ["rev-parse", "--is-inside-work-tree"], {
      timeoutMs: 10_000,
    })
    return stdout.trim() === "true"
  } catch {
    return false
  }
}

/**
 * The repository's display name. Prefer the toplevel directory's basename (what
 * a user calls the project); fall back to the passed dir's basename if the
 * toplevel can't be resolved.
 */
export async function repoName(dir: string): Promise<string> {
  try {
    const root = await repoRoot(dir)
    return basename(root)
  } catch {
    return basename(dir)
  }
}

/** Absolute path of the repository's top-level working directory. */
export async function repoRoot(dir: string): Promise<string> {
  const { stdout } = await runGit(dir, ["rev-parse", "--show-toplevel"], {
    timeoutMs: 10_000,
  })
  return stdout.trim()
}

/**
 * The repository's default branch (e.g. "main"). Resolution order, most to least
 * authoritative:
 *   1. `origin/HEAD`'s symbolic target — the remote's chosen default.
 *   2. `init.defaultBranch` config, if set.
 *   3. The current branch, as a last resort.
 * Returns null only when none can be determined (e.g. an unborn HEAD with no
 * remote and no config).
 */
export async function resolveDefaultBranch(dir: string): Promise<string | null> {
  const fromRemote = await runGit(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    timeoutMs: 10_000,
    allowFailure: true,
  })
  const remoteRef = fromRemote.stdout.trim()
  if (remoteRef) {
    // Strip the leading "origin/" to get the bare branch name.
    const slash = remoteRef.indexOf("/")
    return slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef
  }

  const fromConfig = await runGit(dir, ["config", "--get", "init.defaultBranch"], {
    timeoutMs: 10_000,
    allowFailure: true,
  })
  const configured = fromConfig.stdout.trim()
  if (configured) return configured

  return currentBranch(dir)
}

/**
 * The branch currently checked out in `dir`, or null on a detached HEAD or an
 * unborn branch (a fresh repo before its first commit, where the symbolic ref
 * exists but the branch name still resolves via HEAD).
 */
export async function currentBranch(dir: string): Promise<string | null> {
  const { stdout } = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"], {
    timeoutMs: 10_000,
    allowFailure: true,
  })
  const name = stdout.trim()
  if (!name || name === "HEAD") {
    // Detached HEAD reports "HEAD"; an unborn branch reports nothing here, so
    // ask for the symbolic ref git would create on first commit.
    const symbolic = await runGit(dir, ["symbolic-ref", "--short", "HEAD"], {
      timeoutMs: 10_000,
      allowFailure: true,
    })
    const ref = symbolic.stdout.trim()
    return ref || null
  }
  return name
}

/** Whether a local branch with `name` exists in the repo at `dir`. */
export async function branchExists(dir: string, name: string): Promise<boolean> {
  const { stdout } = await runGit(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], {
    timeoutMs: 10_000,
    allowFailure: true,
  })
  // `--quiet` prints nothing; success is signalled by exit code, which
  // allowFailure swallows. Re-check via for-each-ref to get a definite answer.
  void stdout
  const { stdout: listed } = await runGit(
    dir,
    ["for-each-ref", "--format=%(refname:short)", `refs/heads/${name}`],
    { timeoutMs: 10_000, allowFailure: true },
  )
  return listed.trim() === name
}

export interface AddWorktreeOptions {
  /**
   * Create `branch` as a new branch rather than checking out an existing one.
   * Defaults to true (the common "new workspace = new branch" path).
   */
  createBranch?: boolean
}

/**
 * Add a git worktree at `worktreeDir` for `branch` in the repo at `repoDir`.
 *
 * With `createBranch` (default), runs `git worktree add -b <branch> <dir>
 * [<baseBranch>]` — creating a fresh branch off `baseBranch` (or the current
 * HEAD when omitted). With `createBranch: false`, checks out the existing
 * `branch` into the new worktree. Throws {@link GitError} on failure (e.g. a
 * branch name already checked out elsewhere).
 */
export async function addWorktree(
  repoDir: string,
  worktreeDir: string,
  branch: string,
  baseBranch?: string,
  options: AddWorktreeOptions = {},
): Promise<void> {
  const createBranch = options.createBranch ?? true
  const args = ["worktree", "add"]
  if (createBranch) {
    args.push("-b", branch, worktreeDir)
    if (baseBranch) args.push(baseBranch)
  } else {
    args.push(worktreeDir, branch)
  }
  await runGit(repoDir, args)
}

/**
 * Remove the worktree at `worktreeDir` from the repo at `repoDir`. `--force`
 * removes it even with local modifications (the workspace row is being deleted,
 * so the checkout is disposable). Tolerant of an already-removed worktree:
 * `git worktree remove` errors if the path is gone, which for a delete is a
 * success, so that case is swallowed and a prune keeps git's metadata tidy.
 */
export async function removeWorktree(repoDir: string, worktreeDir: string): Promise<void> {
  try {
    await runGit(repoDir, ["worktree", "remove", "--force", worktreeDir])
  } catch (error) {
    if (!(error instanceof GitError)) throw error
    const stderr = error.stderr.toLowerCase()
    const alreadyGone = stderr.includes("is not a working tree") || stderr.includes("not found")
    if (!alreadyGone) throw error
  }
  // Drop any stale administrative entries for worktrees no longer on disk.
  await runGit(repoDir, ["worktree", "prune"], { allowFailure: true })
}

/**
 * Working-tree status of `dir` as a typed list of changes (staged + unstaged +
 * untracked). Backed by `git status --porcelain=v2 -z`; a clean tree yields an
 * empty list.
 */
export async function status(dir: string): Promise<GitChange[]> {
  const { stdout } = await runGit(dir, ["status", "--porcelain=v2", "--untracked-files=all", "-z"])
  return parseStatusV2(stdout)
}
