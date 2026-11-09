import { existsSync } from "node:fs"
import { realpath } from "node:fs/promises"
import {
  getSettingsOrDefaults,
  type PiLabDatabase,
  type ProjectPaper,
  projects,
} from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { isGitRepo, repoRoot, runGit } from "../git"
import { addLocalExclude } from "../git/remote"
import { normalizeOutputDir, outputDirProblem, outputExcludePatterns } from "../latex/outputDir"
import { findRootTex, listPaperFiles } from "./files"

/**
 * Where a linked paper's LaTeX build output goes, and keeping that output out
 * of the paper repo's commits (so Sync never sends it to Overleaf).
 */

/** True when `dir` is the top folder of its own Git repository (not a subfolder of another repo). */
export async function isOwnRepo(dir: string): Promise<boolean> {
  if (!(await isGitRepo(dir))) return false
  return (await realpath(await repoRoot(dir))) === (await realpath(dir))
}

/** The paper's build output folder: its own override, else the global default. */
export function effectiveOutputDir(paper: ProjectPaper, defaultOutputDir: string): string {
  return paper.outputDir ?? defaultOutputDir
}

/**
 * Add the build output of `outputDir` to the paper repo's local
 * `.git/info/exclude` (never `.gitignore`). Does nothing when the paper folder
 * is not the top of its own Git repository.
 *
 * @param rootRelPath the root .tex relative to the paper folder, or null when
 *   it is not known (then "." has nothing to exclude yet)
 */
export async function excludePaperOutputs(
  paperDir: string,
  outputDir: string,
  rootRelPath: string | null,
): Promise<void> {
  if (!(await isOwnRepo(paperDir))) return
  for (const pattern of outputExcludePatterns(outputDir, rootRelPath)) {
    await addLocalExclude(paperDir, pattern)
  }
}

/**
 * Exclude the effective output of one paper, using its main .tex as the root.
 * Does nothing when Sync is off for the paper: nothing is pushed then, and the
 * paper may be the project folder, whose own repo should not get these rules.
 */
export async function excludeEffectiveOutputs(
  paper: ProjectPaper,
  defaultOutputDir: string,
): Promise<void> {
  if (paper.syncEnabled === false) return
  const root = await findRootTex(paper.dir, await listPaperFiles(paper.dir))
  await excludePaperOutputs(paper.dir, effectiveOutputDir(paper, defaultOutputDir), root)
}

/**
 * After the global default changes: exclude it in every linked paper that has
 * no override. A paper folder that no longer exists has no output to exclude.
 */
export async function excludeDefaultOutputs(db: PiLabDatabase): Promise<void> {
  const defaultOutputDir = getSettingsOrDefaults(db).editor.latexOutputDir
  for (const project of db.select().from(projects).all()) {
    const paper = project.metadata?.paper
    if (paper && paper.outputDir === undefined && existsSync(paper.dir)) {
      await excludeEffectiveOutputs(paper, defaultOutputDir)
    }
  }
}

/**
 * A file tracked in the paper repo that lies in a folder named `outputDir` (at
 * any depth, as the exclude rule matches it), or null. Excluding such a folder
 * would hide sources (e.g. `figures`) from Sync. "." is not a folder and is
 * never refused here.
 */
export async function trackedFileInOutputDir(
  paperDir: string,
  outputDir: string,
): Promise<string | null> {
  if (outputDir === "." || !(await isOwnRepo(paperDir))) return null
  const { stdout } = await runGit(paperDir, ["ls-files", "-z"], {})
  const folder = `${outputDir}/`
  return (
    stdout.split("\0").find((file) => file.startsWith(folder) || file.includes(`/${folder}`)) ??
    null
  )
}

/** The message for an output folder that holds the tracked file `file`. */
function trackedFolderMessage(outputDir: string, where: string, file: string): string {
  return `The folder "${outputDir}" holds files tracked in the paper repo${where} (${file}). Choose another folder for the build output.`
}

/** Refuse (BAD_REQUEST) a paper's own output folder that holds tracked files. */
export async function requireUntrackedOutputDir(
  paperDir: string,
  outputDir: string,
): Promise<void> {
  const file = await trackedFileInOutputDir(paperDir, outputDir)
  if (file) {
    throw new TRPCError({ code: "BAD_REQUEST", message: trackedFolderMessage(outputDir, "", file) })
  }
}

/**
 * Refuse (BAD_REQUEST) a new global default output folder that holds tracked
 * files in a linked paper using the default (no override), naming its project.
 */
export async function requireUntrackedDefaultOutputDir(
  db: PiLabDatabase,
  outputDir: string,
): Promise<void> {
  for (const project of db.select().from(projects).all()) {
    const paper = project.metadata?.paper
    if (!paper || paper.outputDir !== undefined || !existsSync(paper.dir)) continue
    const file = await trackedFileInOutputDir(paper.dir, outputDir)
    if (file) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: trackedFolderMessage(outputDir, ` of project "${project.name}"`, file),
      })
    }
  }
}

/** {@link normalizeOutputDir}, with a problem sent to the renderer as BAD_REQUEST. */
export function outputDirOrBadRequest(value: string): string {
  const problem = outputDirProblem(value)
  if (problem) throw new TRPCError({ code: "BAD_REQUEST", message: problem })
  return normalizeOutputDir(value)
}
