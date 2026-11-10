/// <reference types="vite/client" />
import { existsSync } from "node:fs"
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { hasTopLevelTex } from "./detect"
import mainTex from "./template/main.tex?raw"
import referencesBib from "./template/references.bib?raw"
import styleSty from "./template/style.sty?raw"

/**
 * The LaTeX template "Create paper" copies into a new paper folder. PI Lab
 * ships a built-in one; the user can replace it with their own folder in
 * Settings > LaTeX. The user's template is copied into the data folder when it
 * is set, so later changes to (or removal of) the source folder do not change
 * it, and clearing it goes back to the built-in one.
 */

/** One file of the built-in template. */
export interface TemplateFile {
  relPath: string
  content: string
}

/** The built-in template's files. */
export const BUILT_IN_TEMPLATE: readonly TemplateFile[] = [
  { relPath: "main.tex", content: mainTex },
  { relPath: "references.bib", content: referencesBib },
  { relPath: "style.sty", content: styleSty },
]

/** Which template "Create paper" uses. */
export interface TemplateStatus {
  /** The user's own template, or null when the built-in one is used. */
  custom: {
    /** The folder it was copied from. */
    source: string
    /** When it was set (epoch ms). */
    setAt: number
    /** Its files, relative to the template folder, sorted. */
    files: string[]
  } | null
}

/** Folder in the data folder holding the user's template. */
const TEMPLATE_DIR = "latex-template"
/** File in the data folder recording where the user's template came from. */
const TEMPLATE_INFO = "latex-template.json"
/** Entries never copied from a template folder. */
const SKIPPED = new Set([".git", ".DS_Store"])
/** Limits that stop a large folder (a whole project) being taken as a template by mistake. */
const MAX_FILES = 500
const MAX_BYTES = 50 * 1024 * 1024

/** Files under `dir` (relative, "/" separators, sorted), skipping {@link SKIPPED}; refuses symbolic links. */
async function templateFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  let bytes = 0
  const visit = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue
      const path = join(folder, entry.name)
      const rel = relative(dir, path).split(sep).join("/")
      if (entry.isSymbolicLink()) {
        throw new Error(`A LaTeX template folder cannot contain symbolic links: ${rel}`)
      }
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      files.push(rel)
      bytes += (await lstat(path)).size
      if (files.length > MAX_FILES || bytes > MAX_BYTES) {
        throw new Error(
          `A LaTeX template folder can hold at most ${MAX_FILES} files and 50 MB. Choose the template's own folder.`,
        )
      }
    }
  }
  await visit(dir)
  return files.sort()
}

/** The template in use; see {@link TemplateStatus}. */
export async function templateStatus(dataDir: string): Promise<TemplateStatus> {
  const infoPath = join(dataDir, TEMPLATE_INFO)
  const templateDir = join(dataDir, TEMPLATE_DIR)
  if (!existsSync(infoPath) || !existsSync(templateDir)) return { custom: null }
  const info = JSON.parse(await readFile(infoPath, "utf8")) as { source: string; setAt: number }
  return {
    custom: { source: info.source, setAt: info.setAt, files: await templateFiles(templateDir) },
  }
}

/**
 * Use the folder `source` as the template from now on, replacing any earlier
 * one. It must have a .tex file at its top level and no symbolic links. Its
 * files are copied, without `.git` and `.DS_Store`.
 */
export async function setCustomTemplate(dataDir: string, source: string): Promise<TemplateStatus> {
  if (!existsSync(source) || !(await stat(source)).isDirectory()) {
    throw new Error(`Not a folder: ${source}`)
  }
  if (!(await hasTopLevelTex(source))) {
    throw new Error("A LaTeX template folder needs a .tex file at its top level")
  }
  await templateFiles(source)
  const templateDir = join(dataDir, TEMPLATE_DIR)
  const staging = join(dataDir, `${TEMPLATE_DIR}.new`)
  await rm(staging, { recursive: true, force: true })
  await cp(source, staging, {
    recursive: true,
    filter: (path) => !SKIPPED.has(path.split(sep).pop() ?? ""),
  })
  await rm(templateDir, { recursive: true, force: true })
  await rename(staging, templateDir)
  await writeFile(
    join(dataDir, TEMPLATE_INFO),
    JSON.stringify({ source, setAt: Date.now() }, null, 2),
  )
  return templateStatus(dataDir)
}

/** Go back to the built-in template. */
export async function clearCustomTemplate(dataDir: string): Promise<TemplateStatus> {
  await rm(join(dataDir, TEMPLATE_INFO), { force: true })
  await rm(join(dataDir, TEMPLATE_DIR), { recursive: true, force: true })
  return templateStatus(dataDir)
}

/** Copy the template in use into the existing folder `target`. */
export async function writeTemplate(dataDir: string, target: string): Promise<void> {
  if ((await templateStatus(dataDir)).custom) {
    await cp(join(dataDir, TEMPLATE_DIR), target, { recursive: true })
    return
  }
  for (const file of BUILT_IN_TEMPLATE) {
    await mkdir(join(target, file.relPath, ".."), { recursive: true })
    await writeFile(join(target, file.relPath), file.content)
  }
}
