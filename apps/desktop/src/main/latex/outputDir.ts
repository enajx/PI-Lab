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
 * fine: it is empty, absolute, or has a `..` part (it could then point outside
 * the paper folder).
 */
export function outputDirProblem(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === "") return "Enter a folder for the build output, or . for next to the .tex file"
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[A-Za-z]:/.test(trimmed)) {
    return `The build output folder must be relative to the .tex file's folder: ${trimmed}`
  }
  if (trimmed.split(/[/\\]/).includes("..")) {
    return `The build output folder cannot contain "..": ${trimmed}`
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
  const normalized = posix.normalize(value.trim().split("\\").join("/")).replace(/\/+$/, "")
  return normalized === "" ? "." : normalized
}

/**
 * Lines for the paper repo's `.git/info/exclude` that keep build output out of
 * commits. A folder is excluded wherever it sits (every root .tex builds into
 * its own `<folder>`). For "." the root's PDF is excluded by name (other PDFs
 * can be figures) and build-only files (.aux, .log, ...) anywhere.
 *
 * @param outputDir a value returned by {@link normalizeOutputDir}
 * @param rootRelPath the root .tex relative to the paper folder, or null
 */
export function outputExcludePatterns(outputDir: string, rootRelPath: string | null): string[] {
  if (outputDir !== ".") return [outputDir.includes("/") ? `**/${outputDir}/` : `${outputDir}/`]
  // Build-only files are excluded anywhere (chapters pulled in with \include write
  // their own .aux next to them); a PDF can be a source figure, so only the root's
  // PDF is excluded, by name.
  const buildOnly = GENERATED_EXTENSIONS.filter((extension) => extension !== ".pdf").map(
    (extension) => `*${extension}`,
  )
  if (rootRelPath === null) return buildOnly
  return [`/${rootRelPath.replace(/\.tex$/i, "")}.pdf`, ...buildOnly]
}
