import { type Dirent, existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { runGit } from "../git"
import { isOwnRepo } from "./outputs"
import { isOverleafUrl } from "./overleaf"

/**
 * Finding Overleaf Git clones in a project, so the LaTeX Editor can link the
 * paper folder without asking. A folder counts as an Overleaf clone when it is
 * the top of its own Git repository and the `origin` URL written in its Git
 * config has the Overleaf host. The configured URL is read as written
 * (`git config remote.origin.url`), before any `url.<base>.insteadOf` rewrite.
 */

/** How many folder levels below the project folder are searched. */
const MAX_DEPTH = 3

/** Most folders looked at in one search; the search stops there and says so. */
const MAX_FOLDERS = 5_000

/** Folder names never searched: dependencies, environments and build output. Hidden folders are skipped too. */
const SKIPPED_NAMES = new Set([
  "node_modules",
  "venv",
  "__pycache__",
  "build",
  "dist",
  "out",
  "target",
])

/** readdir error codes for a folder that is skipped: it cannot be read, or it was removed meanwhile. */
const SKIPPED_ERROR_CODES = new Set(["EACCES", "ENOENT"])

/** An Overleaf clone found in a project. */
export interface OverleafClone {
  /** Absolute path of the clone. */
  dir: string
  /** Path relative to the project folder, with "/" separators; "." for the project folder. */
  relPath: string
}

/** Result of {@link findOverleafClones}. */
export interface OverleafCloneSearch {
  clones: OverleafClone[]
  /** True when the search stopped at {@link MAX_FOLDERS} folders, so clones may be missing. */
  stoppedEarly: boolean
}

/**
 * The folders inside `dir`, or null when `dir` cannot be read or has been
 * removed. Any other error is thrown.
 */
async function readFolder(dir: string): Promise<Dirent[] | null> {
  return readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== undefined && SKIPPED_ERROR_CODES.has(error.code)) return null
    throw error
  })
}

/** The `origin` URL as written in the repo's config, or null when there is none. */
export async function configuredOriginUrl(dir: string): Promise<string | null> {
  const { stdout } = await runGit(dir, ["config", "--get", "remote.origin.url"], {
    allowFailure: true,
  })
  const url = stdout.trim()
  return url === "" ? null : url
}

/** True when `dir` is the top of its own Git repo and its configured `origin` is an Overleaf URL. */
export async function isOverleafClone(dir: string): Promise<boolean> {
  if (!(await isOwnRepo(dir))) return false
  const url = await configuredOriginUrl(dir)
  return url !== null && isOverleafUrl(url)
}

/**
 * Every Overleaf clone in `projectDir` (a real path): the folder itself and
 * folders up to {@link MAX_DEPTH} levels below it, skipping hidden folders,
 * symbolic links, dependencies, build output, and folders that cannot be read
 * or were removed meanwhile. Clones inside other clones are found too. Stops
 * after {@link MAX_FOLDERS} folders and says so. Sorted by relative path.
 */
export async function findOverleafClones(projectDir: string): Promise<OverleafCloneSearch> {
  const found: OverleafClone[] = []
  let visited = 0
  let stoppedEarly = false
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (visited === MAX_FOLDERS) {
      stoppedEarly = true
      return
    }
    visited++
    if (existsSync(join(dir, ".git")) && (await isOverleafClone(dir))) {
      const rel = relative(projectDir, dir).split(sep).join("/")
      found.push({ dir, relPath: rel === "" ? "." : rel })
    }
    if (depth === MAX_DEPTH) return
    for (const entry of (await readFolder(dir)) ?? []) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED_NAMES.has(entry.name)) {
        continue
      }
      await visit(join(dir, entry.name), depth + 1)
    }
  }
  await visit(projectDir, 0)
  const clones = found.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  return { clones, stoppedEarly }
}
