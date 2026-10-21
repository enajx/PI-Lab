import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"

/** Directory names shared by workspace search and Analysis discovery. */
export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "env",
  ".cache",
  ".turbo",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".ipynb_checkpoints",
]

/** Options for a breadth-first workspace walk. */
export interface WalkPolicy {
  ignore?: readonly string[]
  /** Hidden entries are included by default. */
  includeHidden?: boolean
  /** Zero visits only direct children of the root. */
  maxDepth?: number
}

/** One regular file or directory found during a workspace walk. */
export interface WalkEntry {
  path: string
  name: string
  kind: "file" | "dir"
  /** Direct children of the root have depth zero. */
  depth: number
}

export type WalkDecision = "continue" | "prune" | "stop"
export type WalkVisitor = (entry: WalkEntry) => WalkDecision | Promise<WalkDecision>

/** Expected child errors are reported by relative path instead of hidden. */
export interface WalkResult {
  stopped: boolean
  partial: boolean
  skipped: string[]
}

/**
 * Visit a workspace breadth-first. A visitor may stop the walk or prune a
 * directory, including a directory artifact such as `.zarr`.
 */
export async function walkWorkspace(
  root: string,
  policy: WalkPolicy,
  visitor: WalkVisitor,
): Promise<WalkResult> {
  const ignored = new Set([...DEFAULT_IGNORED_DIRS, ...(policy.ignore ?? [])])
  const maxDepth = policy.maxDepth ?? Number.POSITIVE_INFINITY
  const skipped: string[] = []
  let frontier = [root]
  let depth = 0

  while (frontier.length > 0 && depth <= maxDepth) {
    const next: string[] = []
    // Read small batches ahead, but run visitors in the original BFS order.
    // Errors are consumed in that order too; a stopped walk ignores unused reads.
    for (let offset = 0; offset < frontier.length; offset += 4) {
      const directories = await Promise.all(
        frontier.slice(offset, offset + 4).map((dir) =>
          readdir(dir, { withFileTypes: true }).then(
            (dirents) => ({ dir, dirents, error: null }),
            (error: unknown) => ({ dir, dirents: null, error }),
          ),
        ),
      )
      for (const { dir, dirents, error } of directories) {
        if (dirents === null) {
          if (dir !== root && isExpectedChildError(error)) {
            skipped.push(toRelativePath(root, dir))
            continue
          }
          throw error
        }
        dirents.sort((a, b) => a.name.localeCompare(b.name))

        for (const dirent of dirents) {
          if (policy.includeHidden === false && dirent.name.startsWith(".")) continue
          const kind = dirent.isFile() ? "file" : dirent.isDirectory() ? "dir" : null
          if (!kind || (kind === "dir" && ignored.has(dirent.name))) continue
          const path = join(dir, dirent.name)
          const decision = await Promise.resolve()
            .then(() => visitor({ path, name: dirent.name, kind, depth }))
            .catch((error: unknown) => {
              if (isExpectedChildError(error)) {
                skipped.push(toRelativePath(root, path))
                return "prune" as const
              }
              throw error
            })
          if (decision === "stop") return { stopped: true, partial: skipped.length > 0, skipped }
          if (kind === "dir" && decision !== "prune" && depth < maxDepth) next.push(path)
        }
      }
    }
    frontier = next
    depth += 1
  }

  return { stopped: false, partial: skipped.length > 0, skipped }
}

function isExpectedChildError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  return ["EACCES", "EPERM", "ENOENT"].includes(String(error.code))
}

function toRelativePath(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/")
}
