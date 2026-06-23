/**
 * Parser for `git status --porcelain=v2 -z`, turning git's machine format into a
 * typed list of working-tree changes. Kept pure (no I/O) so it is unit-testable
 * in isolation and reusable by the changes pane.
 *
 * Porcelain v2 record types we recognize (see `git status` docs):
 *   - "1" ordinary changed entry:   `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
 *   - "2" renamed/copied entry:     `2 <XY> <sub> … <Xscore> <path>\0<origPath>`
 *   - "u" unmerged entry:           `u <XY> …                          <path>`
 *   - "?" untracked:                `? <path>`
 *   - "!" ignored:                  `! <path>` (omitted unless asked for)
 *
 * The two-letter `XY` field is (staged, unstaged) status. We collapse it to a
 * single high-level {@link ChangeStatus} for the UI while keeping the raw codes.
 */

/** High-level classification of a single path's change. */
export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflicted"
  | "typechange"

/** One changed path in the working tree. */
export interface GitChange {
  /** Path relative to the repository root (POSIX separators, as git reports). */
  path: string
  /** For renames/copies, the path the entry came from. */
  originalPath?: string
  /** Collapsed, UI-friendly status. */
  status: ChangeStatus
  /** Whether the change is (at least partly) staged in the index. */
  staged: boolean
  /** Raw two-character `XY` code from porcelain v2 (e.g. "M.", ".M", "A."). */
  raw: string
}

/** Map a single porcelain status char to a high-level status. */
function classifyCode(code: string): ChangeStatus {
  switch (code) {
    case "A":
      return "added"
    case "D":
      return "deleted"
    case "R":
      return "renamed"
    case "C":
      return "copied"
    case "T":
      return "typechange"
    default:
      return "modified"
  }
}

/**
 * Collapse an `XY` pair into one status + staged flag. The index column (`X`)
 * wins when it carries a change; otherwise the worktree column (`Y`) drives it.
 */
function classifyXY(xy: string): { status: ChangeStatus; staged: boolean } {
  const indexCode = xy[0] ?? "."
  const worktreeCode = xy[1] ?? "."
  if (indexCode !== "." && indexCode !== " ") {
    return { status: classifyCode(indexCode), staged: true }
  }
  return { status: classifyCode(worktreeCode), staged: false }
}

/**
 * Parse the NUL-delimited output of `git status --porcelain=v2 -z` into a typed
 * list. Empty input yields an empty list (a clean tree).
 */
export function parseStatusV2(output: string): GitChange[] {
  if (output.length === 0) return []

  // `-z` separates records (and, for renames, the two paths) with NUL. We walk
  // the token stream because a rename record consumes a trailing extra token.
  const tokens = output.split("\0").filter((token) => token.length > 0)
  const changes: GitChange[] = []

  for (let i = 0; i < tokens.length; i += 1) {
    const record = tokens[i]
    if (!record) continue
    const recordType = record[0]

    if (recordType === "1") {
      // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
      const fields = record.split(" ")
      const xy = fields[1] ?? ".."
      const path = fields.slice(8).join(" ")
      const { status, staged } = classifyXY(xy)
      changes.push({ path, status, staged, raw: xy })
    } else if (recordType === "2") {
      // `2 <XY> … <Xscore> <path>` then a separate NUL-terminated `<origPath>`.
      const fields = record.split(" ")
      const xy = fields[1] ?? ".."
      const path = fields.slice(9).join(" ")
      const originalPath = tokens[i + 1]
      i += 1 // consume the origin-path token
      const { staged } = classifyXY(xy)
      changes.push({
        path,
        originalPath,
        status: xy[0] === "C" || xy[1] === "C" ? "copied" : "renamed",
        staged,
        raw: xy,
      })
    } else if (recordType === "u") {
      // `u <XY> …  <path>` — an unmerged (conflicted) entry.
      const fields = record.split(" ")
      const xy = fields[1] ?? ".."
      const path = fields.slice(10).join(" ")
      changes.push({ path, status: "conflicted", staged: false, raw: xy })
    } else if (recordType === "?") {
      const path = record.slice(2)
      changes.push({ path, status: "untracked", staged: false, raw: "??" })
    } else if (recordType === "!") {
      const path = record.slice(2)
      changes.push({ path, status: "ignored", staged: false, raw: "!!" })
    }
  }

  return changes
}
