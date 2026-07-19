/**
 * Browser-safe persisted representation of an imported VS Code JSON color
 * theme. It contains copied, sanitized values only—never the source file path.
 */
export interface ImportedEditorTheme {
  id: string
  name: string
  mode: "light" | "dark"
  colors: ImportedEditorThemeColors
  tokenColors: ImportedEditorTokenColor[]
}

export interface ImportedEditorThemeColors {
  background: string
  foreground: string
  caret?: string
  selection?: string
  selectionMatch?: string
  lineHighlight?: string
  gutterBackground?: string
  gutterForeground?: string
  activeLineNumber?: string
}

export interface ImportedEditorTokenColor {
  scopes: string[]
  foreground?: string
  fontStyle?: string
}

const COLOR_KEY_MAP: Readonly<Record<string, keyof ImportedEditorThemeColors>> = {
  "editor.background": "background",
  "editor.foreground": "foreground",
  "editorCursor.foreground": "caret",
  "editor.selectionBackground": "selection",
  "editor.findMatchBackground": "selectionMatch",
  "editor.findMatchHighlightBackground": "selectionMatch",
  "editor.lineHighlightBackground": "lineHighlight",
  "editorGutter.background": "gutterBackground",
  "editorLineNumber.foreground": "gutterForeground",
  "editorLineNumber.activeForeground": "activeLineNumber",
}

const SUPPORTED_FONT_STYLES = new Set(["italic", "bold", "underline"])
const CSS_HEX_COLOR = /^#[0-9a-f]{3,4}(?:[0-9a-f]{3,4})?$/iu

/**
 * Parse and sanitize one VS Code JSON color theme. Unsupported fields are
 * dropped; malformed/inherited themes throw a user-facing error.
 */
export function parseVSCodeColorTheme(
  source: string,
  fallbackFilename: string,
): ImportedEditorTheme {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new Error("Theme file is not valid JSON")
  }
  if (!isRecord(parsed)) throw new Error("Theme JSON must contain an object")
  if (typeof parsed.include === "string") {
    throw new Error("Theme inheritance via include is not supported")
  }

  const rawColors = isRecord(parsed.colors) ? parsed.colors : {}
  const colors: Partial<ImportedEditorThemeColors> = {}
  for (const [vscodeKey, storedKey] of Object.entries(COLOR_KEY_MAP)) {
    const color = sanitizeColor(rawColors[vscodeKey])
    if (color) colors[storedKey] = color
  }
  if (!colors.background) throw new Error("Theme must define a valid editor.background color")
  if (!colors.foreground) throw new Error("Theme must define a valid editor.foreground color")

  const fallbackName = filenameStem(fallbackFilename)
  const name = sanitizeName(parsed.name) || fallbackName || "Imported theme"
  const mode = themeMode(parsed.type, colors.background)
  const tokenColors = sanitizeTokenColors(parsed.tokenColors)
  const stableContent = JSON.stringify({ name, mode, colors, tokenColors })
  return {
    id: `custom:${slug(name)}:${fnv1a(stableContent)}`,
    name,
    mode,
    colors: colors as ImportedEditorThemeColors,
    tokenColors,
  }
}

function sanitizeTokenColors(value: unknown): ImportedEditorTokenColor[] {
  if (!Array.isArray(value)) return []
  const result: ImportedEditorTokenColor[] = []
  for (const entry of value.slice(0, 512)) {
    if (!isRecord(entry) || !isRecord(entry.settings)) continue
    const scopes = sanitizeScopes(entry.scope)
    if (scopes.length === 0) continue
    const foreground = sanitizeColor(entry.settings.foreground)
    const fontStyle = sanitizeFontStyle(entry.settings.fontStyle)
    if (!foreground && !fontStyle) continue
    result.push({
      scopes,
      ...(foreground ? { foreground } : {}),
      ...(fontStyle ? { fontStyle } : {}),
    })
  }
  return result
}

function sanitizeScopes(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
  const scopes: string[] = []
  for (const item of raw) {
    if (typeof item !== "string") continue
    for (const scope of item.split(",")) {
      const clean = scope.trim().slice(0, 160)
      if (/^[a-z0-9_. -]+$/iu.test(clean) && !scopes.includes(clean)) scopes.push(clean)
    }
  }
  return scopes.slice(0, 64)
}

function sanitizeColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const clean = value.trim()
  return CSS_HEX_COLOR.test(clean) ? clean.toLowerCase() : undefined
}

function sanitizeFontStyle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const styles = value.split(/\s+/u).filter((style) => SUPPORTED_FONT_STYLES.has(style))
  return styles.length > 0 ? [...new Set(styles)].join(" ") : undefined
}

function sanitizeName(value: unknown): string {
  if (typeof value !== "string") return ""
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code >= 32 && code !== 127
    })
    .join("")
    .trim()
    .slice(0, 100)
}

function filenameStem(value: string): string {
  const basename = value.split(/[\\/]/u).at(-1) ?? ""
  return sanitizeName(basename.replace(/\.json$/iu, ""))
}

function themeMode(value: unknown, background: string): "light" | "dark" {
  if (value === "light" || value === "hcLight") return "light"
  if (value === "dark" || value === "hc") return "dark"
  const hex = background.slice(1)
  const expanded =
    hex.length === 3 || hex.length === 4
      ? hex
          .slice(0, 3)
          .split("")
          .map((char) => char + char)
          .join("")
      : hex.slice(0, 6)
  const red = Number.parseInt(expanded.slice(0, 2), 16)
  const green = Number.parseInt(expanded.slice(2, 4), 16)
  const blue = Number.parseInt(expanded.slice(4, 6), 16)
  return red * 0.299 + green * 0.587 + blue * 0.114 >= 150 ? "light" : "dark"
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 48) || "theme"
  )
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
