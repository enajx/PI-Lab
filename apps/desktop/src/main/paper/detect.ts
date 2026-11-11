import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { runGit } from "../git"
import { isOwnRepo } from "./outputs"
import { isOverleafUrl } from "./overleaf"

/**
 * Finding Overleaf Git clones in a project, so the LaTeX Editor can set the
 * paper folder without asking, and finding paper folders inside a chosen
 * folder that is not a paper folder itself. A folder counts as an Overleaf clone when it is
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

/** True when `entries` (a folder's contents) hold a .tex file. */
function holdsTex(entries: Dirent[]): boolean {
  return entries.some((entry) => entry.isFile() && /\.tex$/i.test(entry.name))
}

/** True when `dir` has a .tex file at its top level. */
export async function hasTopLevelTex(dir: string): Promise<boolean> {
  return holdsTex((await readFolder(dir)) ?? [])
}

/**
 * True when `dir` can be a paper folder: it has a .tex file at its top level,
 * or it is an Overleaf clone.
 */
export async function isPaperFolder(dir: string): Promise<boolean> {
  return (await hasTopLevelTex(dir)) || (await isOverleafClone(dir))
}

/**
 * Visit `rootDir` (a real path) and folders up to {@link MAX_DEPTH} levels
 * below it, skipping hidden folders, symbolic links, dependencies, build
 * output, and folders that cannot be read or were removed meanwhile. `match`
 * gets each folder and its contents and returns a found item or null. Stops
 * after {@link MAX_FOLDERS} folders and says so. Results are sorted by
 * relative path ("/" separators, "." for `rootDir` itself).
 */
async function searchFolders<T>(
  rootDir: string,
  match: (dir: string, entries: Dirent[]) => Promise<Omit<T, "dir" | "relPath"> | null>,
): Promise<{ found: Array<T & { dir: string; relPath: string }>; stoppedEarly: boolean }> {
  const found: Array<T & { dir: string; relPath: string }> = []
  let visited = 0
  let stoppedEarly = false
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (visited === MAX_FOLDERS) {
      stoppedEarly = true
      return
    }
    visited++
    const entries = (await readFolder(dir)) ?? []
    const item = await match(dir, entries)
    if (item !== null) {
      const rel = relative(rootDir, dir).split(sep).join("/")
      found.push({ ...item, dir, relPath: rel === "" ? "." : rel } as T & {
        dir: string
        relPath: string
      })
    }
    if (depth === MAX_DEPTH) return
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED_NAMES.has(entry.name)) {
        continue
      }
      await visit(join(dir, entry.name), depth + 1)
    }
  }
  await visit(rootDir, 0)
  found.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  return { found, stoppedEarly }
}

/** True when `dir` (with `.git` in `entries`) is an Overleaf clone. */
async function cloneIn(dir: string, entries: Dirent[]): Promise<boolean> {
  return entries.some((entry) => entry.name === ".git") && isOverleafClone(dir)
}

/**
 * Every Overleaf clone in `projectDir` (a real path): the folder itself and
 * folders below it as {@link searchFolders} visits them. Clones inside other
 * clones are found too.
 */
export async function findOverleafClones(projectDir: string): Promise<OverleafCloneSearch> {
  const { found, stoppedEarly } = await searchFolders<OverleafClone>(
    projectDir,
    async (dir, entries) => ((await cloneIn(dir, entries)) ? {} : null),
  )
  return { clones: found, stoppedEarly }
}

/** A folder found inside a chosen folder that can be a paper folder. */
export interface PaperCandidate {
  /** Absolute path of the folder. */
  dir: string
  /** Path relative to the chosen folder, with "/" separators. */
  relPath: string
  /** True when it is an Overleaf clone (else it has a .tex file at its top level). */
  overleaf: boolean
}

/** Result of {@link findPapersInside}. */
export interface PaperCandidateSearch {
  papers: PaperCandidate[]
  /** True when the search stopped at {@link MAX_FOLDERS} folders, so papers may be missing. */
  stoppedEarly: boolean
}

/**
 * Folders below `dir` (a real path, not included itself) that can be paper
 * folders: Overleaf clones and folders with a .tex file at their top level,
 * found as {@link searchFolders} visits them.
 */
export async function findPapersInside(dir: string): Promise<PaperCandidateSearch> {
  const { found, stoppedEarly } = await searchFolders<PaperCandidate>(
    dir,
    async (folder, entries) => {
      if (folder === dir) return null
      const overleaf = await cloneIn(folder, entries)
      return overleaf || holdsTex(entries) ? { overleaf } : null
    },
  )
  return { papers: found, stoppedEarly }
}
