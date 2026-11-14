import { readFile, stat } from "node:fs/promises"
import { extname } from "node:path"

/** How a Library viewer tab shows a file. */
export type ViewerKind = "pdf" | "html" | "markdown" | "other"

/** Largest HTML or Markdown file the viewer reads unless the user chooses "Load anyway". */
export const MAX_TEXT_BYTES = 20 * 1024 * 1024

/**
 * Paths that `resolveFile` returned this run. The viewer reads only these, so the renderer
 * cannot read arbitrary files by sending a path. Lives until the app quits.
 */
const granted = new Set<string>()

/** Allow the viewer to read `path` (called once the library resolved it to an item's file). */
export function grantViewerPath(path: string): void {
  granted.add(path)
}

/** Return `path` when `resolveFile` granted it, else throw. */
export function requireGranted(path: string): string {
  if (!granted.has(path)) throw new Error("This file was not opened from the library.")
  return path
}

/** The viewer kind for a file, by extension. */
export function viewerKind(path: string): ViewerKind {
  const ext = extname(path).toLowerCase()
  if (ext === ".pdf") return "pdf"
  if (ext === ".html" || ext === ".htm") return "html"
  if (ext === ".md" || ext === ".markdown") return "markdown"
  return "other"
}

/**
 * The UTF-8 text of an HTML or Markdown viewer file; throws for other kinds, and over 20 MB
 * unless `allowLarge`.
 */
export async function readViewerText(path: string, allowLarge: boolean): Promise<string> {
  const kind = viewerKind(path)
  if (kind !== "html" && kind !== "markdown") throw new Error("Not an HTML or Markdown file.")
  if (!allowLarge && (await stat(path)).size > MAX_TEXT_BYTES)
    throw new Error("File exceeds the 20 MB limit.")
  return readFile(path, "utf8")
}
