import { createHash } from "node:crypto"
import { runGit } from "./runGit"

/**
 * A stable fingerprint of a repository's current git state, used as the cache /
 * re-run trigger for the background project workflows ("Project summary" and
 * "Fetch remote experiments"). A stored workflow result is reused verbatim while
 * this hash is unchanged; any new commit *or* working-tree change flips the hash
 * and triggers a re-run.
 *
 * The hash is a sha256 over three git views, joined by NUL separators so their
 * boundaries can't blur into one another:
 *   - `git rev-parse HEAD`      — the committed tip (empty in a repo with no commits);
 *   - `git status --porcelain`  — staged + unstaged + untracked path states;
 *   - `git diff HEAD`           — the actual unstaged/staged content changes.
 *
 * Every git call runs with `allowFailure`, so a repository with no commits yet
 * (where `rev-parse HEAD` exits non-zero) still yields a deterministic hash from
 * whatever output is available rather than throwing.
 */
export async function computeGitStateHash(repoPath: string): Promise<string> {
  const [head, status, diff] = await Promise.all([
    runGit(repoPath, ["rev-parse", "HEAD"], { allowFailure: true }),
    runGit(repoPath, ["status", "--porcelain"], { allowFailure: true }),
    runGit(repoPath, ["diff", "HEAD"], { allowFailure: true }),
  ])
  const hash = createHash("sha256")
  hash.update(head.stdout)
  hash.update("\0")
  hash.update(status.stdout)
  hash.update("\0")
  hash.update(diff.stdout)
  return hash.digest("hex")
}
