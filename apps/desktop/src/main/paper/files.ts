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

/**
 * Guess the main .tex file of a paper folder, relative to it: `main.tex` at
 * the top when present; else the shallowest `X.tex` with a matching `X.pdf`
 * next to it or in the output folder, when only one is at that depth; else the
 * only .tex file with an uncommented `\documentclass`; else null. The work is
 * bounded: only the {@link MAX_TEX_READS} shallowest .tex files are read (their
 * start) or checked for a PDF in the output folder.
 *
 * @param files the paper's listed files ({@link listPaperFiles})
 * @param outputDir the paper's effective build output folder, relative to a .tex file's folder
 */
export async function guessMainDoc(
  dir: string,
  files: PaperFile[],
  outputDir: string,
): Promise<string | null> {
  const texFiles = files
    .filter((file) => file.kind === "tex")
    .map((file) => file.relPath)
    .sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))
  if (texFiles.includes("main.tex")) return "main.tex"
  const listed = new Set(files.map((file) => file.relPath))
  // A listed PDF is checked for every .tex; a built one only for the shallowest ones.
  const withPdf = texFiles.filter((relPath, index) => {
    const pdf = relPath.replace(/\.tex$/i, ".pdf")
    if (listed.has(pdf)) return true
    const slash = pdf.lastIndexOf("/")
    const built = join(dir, pdf.slice(0, slash + 1), outputDir, pdf.slice(slash + 1))
    return index < MAX_TEX_READS && existsSync(built)
  })
  const first = withPdf[0]
  if (first !== undefined) {
    const shallowest = withPdf.filter((relPath) => depth(relPath) === depth(first))
    if (shallowest.length === 1) return first
  }
  const roots: string[] = []
  for (const relPath of texFiles.slice(0, MAX_TEX_READS)) {
    const source = await readHead(join(dir, relPath))
    const hasClass = source
      .split(/\r?\n/)
      .some((line) => /\\documentclass(?![a-zA-Z])/.test(stripComment(line)))
    if (hasClass) roots.push(relPath)
  }
  return roots.length === 1 ? (roots[0] ?? null) : null
}

/**
 * The main .tex file of a paper folder: the saved choice `mainDoc` while it is
 * a listed .tex file, else {@link guessMainDoc}.
 */
export async function paperMainDoc(
  dir: string,
  mainDoc: string | undefined,
  files: PaperFile[],
  outputDir: string,
): Promise<string | null> {
  if (
    mainDoc !== undefined &&
    files.some((file) => file.kind === "tex" && file.relPath === mainDoc)
  ) {
    return mainDoc
  }
  return guessMainDoc(dir, files, outputDir)
}

/** Read a text file under `dir` for the outline parser; null when it is not a file. */
export function readPaperText(dir: string, relPath: string): string | null {
  const path = join(dir, relPath)
  if (!existsSync(path) || !statSync(path).isFile()) return null
  return readFileSync(path, "utf8")
}
