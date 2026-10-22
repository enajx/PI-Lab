import { basename } from "node:path"
import { type GitChange, parseStatusV2 } from "./parseStatus"
import { GitError, runGit } from "./runGit"

export type { ChangeStatus, GitChange } from "./parseStatus"
export { GitError } from "./runGit"

/** Return false for paths outside a Git working tree. */
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

/** Fall back to the given directory name if the repo root is unavailable. */
export async function repoName(dir: string): Promise<string> {
  try {
    const root = await repoRoot(dir)
    return basename(root)
  } catch {
    return basename(dir)
  }
}

export async function repoRoot(dir: string): Promise<string> {
  const { stdout } = await runGit(dir, ["rev-parse", "--show-toplevel"], {
    timeoutMs: 10_000,
  })
  return stdout.trim()
}

/** Resolve the default branch from origin/HEAD, config, then the current branch. */
export async function resolveDefaultBranch(dir: string): Promise<string | null> {
  const fromRemote = await runGit(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    timeoutMs: 10_000,
    allowFailure: true,
  })
  const remoteRef = fromRemote.stdout.trim()
  if (remoteRef) {
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

/** Return the current branch, including an unborn branch; null for detached HEAD. */
export async function currentBranch(dir: string): Promise<string | null> {
  const { stdout } = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"], {
    timeoutMs: 10_000,
    allowFailure: true,
  })
  const name = stdout.trim()
  if (!name || name === "HEAD") {
    // A new repo may have a symbolic branch even before its first commit.
    const symbolic = await runGit(dir, ["symbolic-ref", "--short", "HEAD"], {
      timeoutMs: 10_000,
      allowFailure: true,
    })
    const ref = symbolic.stdout.trim()
    return ref || null
  }
  return name
}

export async function branchExists(dir: string, name: string): Promise<boolean> {
  const { stdout } = await runGit(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], {
    timeoutMs: 10_000,
    allowFailure: true,
  })
  // allowFailure discards the exit code, so query refs for a definite answer.
  void stdout
  const { stdout: listed } = await runGit(
    dir,
    ["for-each-ref", "--format=%(refname:short)", `refs/heads/${name}`],
    { timeoutMs: 10_000, allowFailure: true },
  )
  return listed.trim() === name
}

export interface AddWorktreeOptions {
  /** Create a branch by default. */
  createBranch?: boolean
}

/** Add a worktree, creating its branch unless `createBranch` is false. */
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

/** Force-remove a worktree and prune Git metadata; tolerate one already gone. */
export async function removeWorktree(repoDir: string, worktreeDir: string): Promise<void> {
  try {
    await runGit(repoDir, ["worktree", "remove", "--force", worktreeDir])
  } catch (error) {
    if (!(error instanceof GitError)) throw error
    const stderr = error.stderr.toLowerCase()
    const alreadyGone = stderr.includes("is not a working tree") || stderr.includes("not found")
    if (!alreadyGone) throw error
  }
  await runGit(repoDir, ["worktree", "prune"], { allowFailure: true })
}

export async function status(dir: string): Promise<GitChange[]> {
  const { stdout } = await runGit(dir, ["status", "--porcelain=v2", "--untracked-files=all", "-z"])
  return parseStatusV2(stdout)
}
