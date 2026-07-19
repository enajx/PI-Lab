import { open } from "node:fs/promises"
import { basename } from "node:path"
import { type ImportedEditorTheme, parseVSCodeColorTheme } from "@pi-lab/local-db"

export const MAX_EDITOR_THEME_BYTES = 1024 * 1024
export const MAX_IMPORTED_EDITOR_THEMES = 20

export interface EditorThemeImportResult {
  themes: ImportedEditorTheme[]
  errors: Array<{ filename: string; message: string }>
}

/**
 * Bounded-read and parse chosen files in main. Only sanitized copied theme data
 * and basename-only errors cross IPC; absolute external paths never do.
 */
export async function readEditorThemeFiles(paths: string[]): Promise<EditorThemeImportResult> {
  const themes: ImportedEditorTheme[] = []
  const errors: EditorThemeImportResult["errors"] = []
  const seen = new Set<string>()

  for (const path of paths.slice(0, MAX_IMPORTED_EDITOR_THEMES)) {
    const filename = basename(path)
    try {
      const source = await readBoundedUtf8(path)
      const theme = parseVSCodeColorTheme(source, filename)
      if (!seen.has(theme.id)) {
        seen.add(theme.id)
        themes.push(theme)
      }
    } catch (error) {
      errors.push({
        filename,
        message: error instanceof Error ? error.message : "Could not import theme",
      })
    }
  }
  if (paths.length > MAX_IMPORTED_EDITOR_THEMES) {
    errors.push({
      filename: "Selection",
      message: `Import at most ${MAX_IMPORTED_EDITOR_THEMES} themes at a time`,
    })
  }
  return { themes, errors }
}

async function readBoundedUtf8(path: string): Promise<string> {
  const handle = await open(path, "r")
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error("Selected theme is not a file")
    if (info.size > MAX_EDITOR_THEME_BYTES) throw new Error("Theme file is too large")
    const bytes = Buffer.alloc(MAX_EDITOR_THEME_BYTES + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > MAX_EDITOR_THEME_BYTES) throw new Error("Theme file is too large")
    return bytes.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
}
