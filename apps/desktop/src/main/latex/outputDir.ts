import { posix } from "node:path"

/**
 * The LaTeX build output folder: a path relative to the root .tex file's
 * folder ("." means next to the .tex). Used by the PDF build, the SyncTeX
 * lookup, and the paper folder's local Git exclude.
 */

/** Extensions of the files a build writes next to the .tex when the output folder is ".". */
export const GENERATED_EXTENSIONS = [
  ".pdf",
  ".aux",
  ".log",
  ".synctex.gz",
  ".fls",
  ".fdb_latexmk",
  ".out",
  ".toc",
  ".bbl",
  ".blg",
] as const

/**
 * Why an output folder typed by the user is not allowed, or null when it is
 * fine. It must be a relative path inside the paper folder (no `..`), and it
 * must read the same as a Git exclude rule: no part starting with `#` or `!`,
 * no `*`, `?`, `[` or `]`, no control characters, no backslash, and no `.git`
 * part.
 */
export function outputDirProblem(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === "") return "Enter a folder for the build output, or . for next to the .tex file"
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is rejected.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return "The build output folder cannot contain line breaks or other control characters"
  }
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    return `The build output folder must be relative to the .tex file's folder: ${trimmed}`
  }
  if (trimmed.includes("\\")) {
    return `Use / to separate folders in the build output folder, not \\: ${trimmed}`
  }
  const parts = trimmed.split("/")
  if (parts.includes("..")) {
    return `The build output folder cannot contain "..": ${trimmed}`
  }
  if (parts.some((part) => part.toLowerCase() === ".git")) {
    return `The build output folder cannot be or contain a .git folder: ${trimmed}`
  }
  if (parts.some((part) => part.startsWith("#") || part.startsWith("!"))) {
    return `A folder name in the build output folder cannot start with # or !: ${trimmed}`
  }
  if (/[*?[\]]/.test(trimmed)) {
    return `The build output folder cannot contain *, ?, [ or ]: ${trimmed}`
  }
  return null
}

/**
 * Check and tidy an output folder typed by the user. Returns the folder with
 * `/` separators and no leading `./` or trailing `/` ("." stays "."). Throws
 * an Error with the {@link outputDirProblem} message when it is not allowed.
 */
export function normalizeOutputDir(value: string): string {
  const problem = outputDirProblem(value)
  if (problem) throw new Error(problem)
  const normalized = posix.normalize(value.trim()).replace(/\/+$/, "")
  return normalized === "" ? "." : normalized
}

/**
 * Lines for the paper repo's `.git/info/exclude` that keep the build output of
 * one root .tex out of commits. The paper folder is the top of that repo, so
 * every line starts with `/` and matches only below the root's own folder: an
 * output folder is excluded only where this root builds into it (not every
 * folder with that name), and for "." the root's own output files are
 * excluded by name (`/main.log`, not `*.log`), plus `.aux` files below the
 * root's folder, which \include'd chapters write next to themselves. Other
 * files with these extensions (such as SLURM `*.out` logs or PDF figures) are
 * never hidden. Each build adds the lines for the root it builds.
 *
 * @param outputDir a value returned by {@link normalizeOutputDir}
 * @param rootRelPath the root .tex relative to the paper folder, or null when
 *   it is not known (then a folder is taken next to the paper folder's top,
 *   and "." has nothing to exclude yet)
 */
export function outputExcludePatterns(outputDir: string, rootRelPath: string | null): string[] {
  const rootDir = rootRelPath === null ? "." : posix.dirname(rootRelPath)
  const base = rootDir === "." ? "/" : `/${rootDir}/`
  if (outputDir !== ".") return [`${base}${outputDir}/`]
  if (rootRelPath === null) return []
  const stem = `/${rootRelPath.replace(/\.tex$/i, "")}`
  return [...GENERATED_EXTENSIONS.map((extension) => `${stem}${extension}`), `${base}**/*.aux`]
}
