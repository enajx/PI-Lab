import { existsSync, readFileSync, statSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { stripComment } from "./outline"

/** Kind of a file shown in the LaTeX Editor file list. */
export type PaperFileKind = "tex" | "bib" | "figure" | "other-text"

/** One listed file of a paper folder. */
export interface PaperFile {
  /** Path relative to the paper folder, with `/` separators. */
  relPath: string
  kind: PaperFileKind
}

const KIND_BY_EXTENSION: Record<string, PaperFileKind> = {
  ".tex": "tex",
  ".bib": "bib",
  ".sty": "other-text",
  ".cls": "other-text",
  ".png": "figure",
  ".jpg": "figure",
  ".jpeg": "figure",
  ".pdf": "figure",
  ".eps": "figure",
  ".svg": "figure",
}

/** Folders never listed: LaTeX build output. Hidden folders (including `.git`) are skipped too. */
const SKIPPED_DIRS = new Set(["build"])

/**
 * List the LaTeX sources (.tex, .bib, .sty, .cls) and figures (png, jpg, jpeg,
 * pdf, eps, svg) in `dir`, sorted by path. Skips `build/` and hidden folders.
 */
export async function listPaperFiles(dir: string): Promise<PaperFile[]> {
  const files: PaperFile[] = []
  const walk = async (relDir: string): Promise<void> => {
    const entries = await readdir(join(dir, relDir), { withFileTypes: true })
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIPPED_DIRS.has(entry.name)) await walk(relPath)
        continue
      }
      const kind = KIND_BY_EXTENSION[extname(entry.name).toLowerCase()]
      if (kind) files.push({ relPath, kind })
    }
  }
  await walk("")
  return files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
}

/**
 * The main .tex file of a paper folder, relative to it: `main.tex` at the top
 * when present, else the only .tex file with an uncommented `\documentclass`,
 * else null (none or several).
 */
export async function findRootTex(dir: string, files: PaperFile[]): Promise<string | null> {
  const texFiles = files.filter((file) => file.kind === "tex")
  if (texFiles.some((file) => file.relPath === "main.tex")) return "main.tex"
  const roots: string[] = []
  for (const file of texFiles) {
    const source = await readFile(join(dir, file.relPath), "utf8")
    const hasClass = source
      .split(/\r?\n/)
      .some((line) => /\\documentclass(?![a-zA-Z])/.test(stripComment(line)))
    if (hasClass) roots.push(file.relPath)
  }
  return roots.length === 1 ? (roots[0] ?? null) : null
}

/** Read a text file under `dir` for the outline parser; null when it is not a file. */
export function readPaperText(dir: string, relPath: string): string | null {
  const path = join(dir, relPath)
  if (!existsSync(path) || !statSync(path).isFile()) return null
  return readFileSync(path, "utf8")
}
