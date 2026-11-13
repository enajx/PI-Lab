import { readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { TRPCError } from "@trpc/server"
import yaml from "js-yaml"

/**
 * The experiments folder structure: how Analysis groups the files of a
 * project's results folder into experiments and runs. The choices live in one
 * global YAML file in PI Lab's data folder, so the user or their agent can edit
 * it by hand:
 *
 *   default: auto
 *   projects:
 *     /Users/me/code/my-project: experiment-run
 *
 * A value is a preset id ({@link STRUCTURE_PRESETS}) or a custom pattern such
 * as `{experiment}/{run}/`. A missing file means `default: auto` and no project
 * entries. An invalid file or value is an error, never a silent fallback.
 */

/** The YAML file's name inside PI Lab's data folder (`app.getPath("userData")`). */
export const STRUCTURE_FILE_NAME = "experiments-structure.yaml"

/** The preset ids, in the order the UI offers them. */
export const STRUCTURE_PRESETS = [
  "auto",
  "one-folder-per-experiment",
  "experiment-run",
  "flat",
] as const
export type StructurePreset = (typeof STRUCTURE_PRESETS)[number]

/** The value used when the file has no `default`. */
export const DEFAULT_STRUCTURE_VALUE: StructurePreset = "auto"

/**
 * A resolved structure. `auto`: every folder that holds data files is a run,
 * grouped by its parent folder. `flat`: no grouping. `pattern`: the leading
 * folders of a file's path are matched against the segments, where
 * `{experiment}` names the group, `{run}` the run, `*` any folder, and any
 * other segment a folder with that exact name.
 */
export type ExperimentsStructure =
  | { kind: "auto" }
  | { kind: "flat" }
  | { kind: "pattern"; segments: string[] }

/** The parsed YAML file. */
export interface StructureFile {
  /** The default structure value (a preset id or a pattern). */
  defaultValue: string
  /** Per-project structure values, keyed by project path. */
  projects: Record<string, string>
}

/** The file's full path inside `userDataDir`. */
export function structureFilePath(userDataDir: string): string {
  return join(userDataDir, STRUCTURE_FILE_NAME)
}

/**
 * Turn a structure value into a structure, or return the reason it is invalid.
 * A value with `{` is a pattern; anything else must be a preset id.
 */
export function parseStructureValue(value: string): ExperimentsStructure | string {
  const trimmed = value.trim()
  if (!trimmed.includes("{") && !trimmed.includes("/")) {
    if (!(STRUCTURE_PRESETS as readonly string[]).includes(trimmed)) {
      return `Unknown experiments structure "${value}". Use one of ${STRUCTURE_PRESETS.join(", ")}, or a pattern such as "{experiment}/{run}/".`
    }
    const preset = trimmed as StructurePreset
    if (preset === "auto") return { kind: "auto" }
    if (preset === "flat") return { kind: "flat" }
    if (preset === "one-folder-per-experiment")
      return { kind: "pattern", segments: ["{experiment}"] }
    return { kind: "pattern", segments: ["{experiment}", "{run}"] }
  }
  const segments = trimmed.replace(/\/+$/, "").split("/")
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return `Invalid pattern "${value}": empty, "." or ".." folder.`
    }
    const isPlaceholder = segment === "{experiment}" || segment === "{run}"
    if (!isPlaceholder && (segment.includes("{") || segment.includes("}"))) {
      return `Invalid pattern "${value}": "${segment}" must be a whole folder, {experiment} or {run}.`
    }
  }
  for (const placeholder of ["{experiment}", "{run}"]) {
    if (segments.filter((segment) => segment === placeholder).length > 1) {
      return `Invalid pattern "${value}": ${placeholder} appears more than once.`
    }
  }
  if (!segments.includes("{experiment}") && !segments.includes("{run}")) {
    return `Invalid pattern "${value}": it needs {experiment} or {run}.`
  }
  return { kind: "pattern", segments }
}

/** {@link parseStructureValue} that throws a BAD_REQUEST with `where` in the message. */
export function requireStructure(value: string, where: string): ExperimentsStructure {
  const parsed = parseStructureValue(value)
  if (typeof parsed === "string") {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${where}: ${parsed}` })
  }
  return parsed
}

/** BAD_REQUEST naming the file, for a file that is not valid. */
function invalidFile(path: string, reason: string): TRPCError {
  return new TRPCError({
    code: "BAD_REQUEST",
    message: `Invalid experiments structure file ${path}: ${reason}`,
  })
}

/**
 * Read and check the structure file. A missing file is the defaults. Invalid
 * YAML, an unknown key, a value that is not text, or an unknown preset or
 * invalid pattern throws BAD_REQUEST naming the file.
 */
export async function readStructureFile(path: string): Promise<StructureFile> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { defaultValue: DEFAULT_STRUCTURE_VALUE, projects: {} }
    }
    throw error
  }
  let data: unknown
  try {
    data = yaml.load(text)
  } catch (error: unknown) {
    throw invalidFile(path, (error as Error).message)
  }
  if (data === null || data === undefined) {
    return { defaultValue: DEFAULT_STRUCTURE_VALUE, projects: {} }
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    throw invalidFile(path, "the file must be a mapping with `default` and `projects`.")
  }
  const record = data as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== "default" && key !== "projects") {
      throw invalidFile(path, `unknown key "${key}" (use \`default\` and \`projects\`).`)
    }
  }
  let defaultValue: string = DEFAULT_STRUCTURE_VALUE
  if (record.default !== undefined) {
    if (typeof record.default !== "string") {
      throw invalidFile(
        path,
        '`default` must be a preset id or a pattern (put a pattern in quotes, for example "{experiment}/{run}/").',
      )
    }
    defaultValue = record.default
    checkValue(path, defaultValue, "default")
  }
  const projects: Record<string, string> = {}
  if (record.projects !== undefined && record.projects !== null) {
    if (typeof record.projects !== "object" || Array.isArray(record.projects)) {
      throw invalidFile(path, "`projects` must map project paths to structures.")
    }
    for (const [projectPath, value] of Object.entries(record.projects)) {
      if (typeof value !== "string") {
        throw invalidFile(
          path,
          `the structure for ${projectPath} must be a preset id or a pattern (put a pattern in quotes, for example "{experiment}/{run}/").`,
        )
      }
      checkValue(path, value, projectPath)
      projects[projectPath] = value
    }
  }
  return { defaultValue, projects }
}

function checkValue(path: string, value: string, where: string): void {
  const parsed = parseStructureValue(value)
  if (typeof parsed === "string") throw invalidFile(path, `${where}: ${parsed}`)
}

const FILE_HEADER = `# PI Lab experiments folder structure, used by Analysis to group results.
# default: the structure for projects without their own entry.
# projects: per-project structures, keyed by project path.
# Values: ${STRUCTURE_PRESETS.join(", ")},
# or a pattern such as "{experiment}/{run}/" ({experiment}, {run}, * or a folder name).
`

/** Write the structure file (header comment, then YAML), replacing it atomically. */
export async function writeStructureFile(path: string, file: StructureFile): Promise<void> {
  const body = yaml.dump({ default: file.defaultValue, projects: file.projects })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${FILE_HEADER}${body}`, "utf8")
  await rename(temp, path)
}

/** The project's structure value, or the default when it has no entry. */
export function effectiveStructureValue(file: StructureFile, projectPath: string): string {
  return file.projects[projectPath] ?? file.defaultValue
}
