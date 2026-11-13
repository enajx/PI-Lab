import { existsSync, readFileSync, statSync } from "node:fs"
import { open, readdir } from "node:fs/promises"
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

/** Result of {@link listPaperFiles}. */
export interface PaperFileList {
  files: PaperFile[]
  /** Subfolders that could not be read (no permission), relative to the paper folder, sorted. */
  unreadable: string[]
}

/**
 * List the LaTeX sources (.tex, .bib, .sty, .cls) and figures (png, jpg, jpeg,
 * pdf, eps, svg) in `dir`, sorted by path. Skips `build/` and hidden folders.
 * A subfolder that cannot be read (EACCES or EPERM) is skipped and listed in
 * `unreadable`; any other error, or an unreadable `dir` itself, is thrown.
 */
export async function listPaperFiles(dir: string): Promise<PaperFileList> {
  const files: PaperFile[] = []
  const unreadable: string[] = []
  const walk = async (relDir: string): Promise<void> => {
    const entries = await readdir(join(dir, relDir), { withFileTypes: true }).then(
      (found) => found,
      (error: NodeJS.ErrnoException) => {
        if (relDir !== "" && (error.code === "EACCES" || error.code === "EPERM")) return null
        throw error
      },
    )
    if (entries === null) {
      unreadable.push(relDir)
      return
    }
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
  return {
    files: files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0)),
    unreadable: unreadable.sort(),
  }
}

/** How many .tex files {@link guessMainDoc} reads at most, the shallowest first. */
const MAX_TEX_READS = 50

/** How many bytes of each .tex file {@link guessMainDoc} reads (`\documentclass` is near the top). */
const TEX_HEAD_BYTES = 32_768

/** Folder depth of a relative path: 0 at the top of the paper folder. */
function depth(relPath: string): number {
  return relPath.split("/").length - 1
}

/** The first {@link TEX_HEAD_BYTES} of a file, as UTF-8 text. */
async function readHead(path: string): Promise<string> {
  const handle = await open(path, "r")
  const buffer = Buffer.alloc(TEX_HEAD_BYTES)
  const { bytesRead } = await handle
    .read(buffer, 0, TEX_HEAD_BYTES, 0)
    .finally(() => handle.close())
  return buffer.subarray(0, bytesRead).toString("utf8")
}

/** True when `source` has an uncommented `\documentclass` that is not `standalone` (a figure). */
function isRootSource(source: string): boolean {
  return source
    .split(/\r?\n/)
    .map(stripComment)
    .some(
      (line) =>
        /\\documentclass(?![a-zA-Z])/.test(line) &&
        !/\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*standalone\s*\}/.test(line),
    )
}

/**
 * Guess the main .tex file of a paper folder, relative to it: `main.tex` at
 * the top when present; else the only .tex file with an uncommented
 * `\documentclass` (not `standalone`); when several have one, the only one of
 * them with a matching `X.pdf` next to it (build output does not count); else
 * null. The work is bounded: only the start of the {@link MAX_TEX_READS}
 * shallowest .tex files is read.
 *
 * @param files the paper's listed files ({@link listPaperFiles})
 */
export async function guessMainDoc(dir: string, files: PaperFile[]): Promise<string | null> {
  const texFiles = files
    .filter((file) => file.kind === "tex")
    .map((file) => file.relPath)
    .sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))
  if (texFiles.includes("main.tex")) return "main.tex"
  const roots: string[] = []
  for (const relPath of texFiles.slice(0, MAX_TEX_READS)) {
    if (isRootSource(await readHead(join(dir, relPath)))) roots.push(relPath)
  }
  if (roots.length === 1) return roots[0] ?? null
  const listed = new Set(files.map((file) => file.relPath))
  const withPdf = roots.filter((relPath) => listed.has(relPath.replace(/\.tex$/i, ".pdf")))
  return withPdf.length === 1 ? (withPdf[0] ?? null) : null
}

/**
 * The main .tex file of a paper folder: the saved choice `mainDoc` while it is
 * a listed .tex file, else {@link guessMainDoc}.
 */
export async function paperMainDoc(
  dir: string,
  mainDoc: string | undefined,
  files: PaperFile[],
): Promise<string | null> {
  if (
    mainDoc !== undefined &&
    files.some((file) => file.kind === "tex" && file.relPath === mainDoc)
  ) {
    return mainDoc
  }
  return guessMainDoc(dir, files)
}

/** Read a text file under `dir` for the outline parser; null when it is not a file. */
export function readPaperText(dir: string, relPath: string): string | null {
  const path = join(dir, relPath)
  if (!existsSync(path) || !statSync(path).isFile()) return null
  return readFileSync(path, "utf8")
}
