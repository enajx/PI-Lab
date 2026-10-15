import type { Extension } from "@codemirror/state"
import { type Tag, tags as t } from "@lezer/highlight"
import type { ImportedEditorTheme } from "@pi-lab/local-db/editor-settings"
import { createTheme } from "@uiw/codemirror-themes"

/**
 * Curated color themes for the built-in CodeMirror editor (TODO "Built-in editor"
 * — "Editor settings group"). The editor core ({@link CodeMirrorBuffer}) ships
 * only `basicSetup` plus a structural height/scroll theme; this registry layers a
 * *color* theme on top, chosen in Settings → Editor and applied live via a
 * compartment.
 *
 * Each palette is a faithful transcription of a well-known scheme using its
 * canonical hex values, so the editor looks professional rather than improvised.
 * Themes are built with `@uiw/codemirror-themes`' `createTheme`, which wraps the
 * settings (chrome colors) and styles (syntax highlighting via `@lezer/highlight`
 * tags) into a single CodeMirror {@link Extension}.
 *
 * The registry holds twelve curated palettes, grouped light-first in the Settings
 * picker, with each label suffixed "(Light)" or
 * "(Dark)". The stored id is a plain string (see `EditorSettings.editorTheme` in
 * `@pi-lab/local-db`) so the DB never couples to this renderer-only registry.
 */

/** A selectable editor color theme: stable id, menu label, palette mode, and extension. */
export interface EditorTheme {
  /** Stable id persisted in `EditorSettings.editorTheme` (never localized/renamed). */
  id: string
  /** User-facing label shown in the Settings select; ends with "(Light)" or "(Dark)". */
  label: string
  /** Whether this is a light- or dark-background palette (drives picker grouping). */
  mode: "light" | "dark"
  /** The CodeMirror extension that paints chrome + syntax for this theme. */
  extension: Extension
  /** Imported themes can be removed; bundled themes cannot. */
  custom?: boolean
}

/**
 * The id used when no theme has been picked yet, or when a stored/legacy id is no
 * longer in the curated set. It is a *real* member of {@link EDITOR_THEMES} (a light
 * theme) and doubles as the fallback for both {@link editorThemeExtension} and the
 * Settings picker, so the editor always renders a defined, styled theme rather than
 * an unstyled buffer.
 */
export const DEFAULT_EDITOR_THEME_ID = "solarized-light"

/** The quick editor follows the current PI Lab appearance without reading settings on launch. */
function piLabEditorTheme(mode: "light" | "dark"): Extension {
  return createTheme({
    theme: mode,
    settings: {
      background: "var(--background)",
      foreground: "var(--foreground)",
      caret: "var(--foreground)",
      selection: "var(--accent)",
      selectionMatch: "var(--secondary)",
      lineHighlight: "var(--muted)",
      gutterBackground: "var(--background)",
      gutterForeground: "var(--muted-foreground)",
    },
    styles: [
      {
        tag: [t.keyword, t.moduleKeyword, t.controlKeyword],
        color: mode === "dark" ? "#d2a8df" : "#7b4b91",
      },
      { tag: [t.string, t.special(t.string)], color: mode === "dark" ? "#a9c49a" : "#4b7547" },
      {
        tag: [t.comment, t.lineComment, t.blockComment],
        color: "var(--muted-foreground)",
        fontStyle: "italic",
      },
      { tag: [t.number, t.bool, t.null], color: mode === "dark" ? "#d6ae87" : "#9a5b30" },
      {
        tag: [t.function(t.variableName), t.function(t.propertyName)],
        color: mode === "dark" ? "#9abfe0" : "#366d9d",
      },
      {
        tag: [t.typeName, t.className, t.namespace],
        color: mode === "dark" ? "#d6ae87" : "#9a5b30",
      },
      { tag: [t.propertyName, t.attributeName], color: mode === "dark" ? "#9abfe0" : "#366d9d" },
      { tag: [t.operator, t.punctuation], color: "var(--foreground)" },
      { tag: [t.variableName, t.definition(t.variableName)], color: "var(--foreground)" },
      { tag: t.invalid, color: "var(--destructive)" },
    ],
  })
}

const piLabLight = piLabEditorTheme("light")
const piLabDark = piLabEditorTheme("dark")

/** One Dark — the Atom palette. */
const oneDark = createTheme({
  theme: "dark",
  settings: {
    background: "#282c34",
    foreground: "#abb2bf",
    caret: "#528bff",
    selection: "#3e4451",
    selectionMatch: "#3e4451",
    lineHighlight: "#2c313c",
    gutterBackground: "#282c34",
    gutterForeground: "#5c6370",
  },
  styles: [
    { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "#c678dd" },
    { tag: [t.string, t.special(t.string)], color: "#98c379" },
    { tag: [t.comment, t.lineComment, t.blockComment], color: "#5c6370", fontStyle: "italic" },
    { tag: [t.number, t.bool, t.null], color: "#d19a66" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#61afef" },
    { tag: [t.typeName, t.className, t.namespace], color: "#e5c07b" },
    { tag: [t.propertyName, t.attributeName], color: "#e06c75" },
    { tag: [t.operator, t.punctuation], color: "#56b6c2" },
    { tag: [t.variableName, t.definition(t.variableName)], color: "#abb2bf" },
    { tag: t.invalid, color: "#e06c75" },
  ],
})

/** Tokyo Night — the "storm"/night palette by enkia. */
const tokyoNight = createTheme({
  theme: "dark",
  settings: {
    background: "#1a1b26",
    foreground: "#a9b1d6",
    caret: "#c0caf5",
    selection: "#283457",
    selectionMatch: "#283457",
    lineHighlight: "#1e202e",
    gutterBackground: "#1a1b26",
    gutterForeground: "#3b4261",
  },
  styles: [
    { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "#bb9af7" },
    { tag: [t.string, t.special(t.string)], color: "#9ece6a" },
    { tag: [t.comment, t.lineComment, t.blockComment], color: "#565f89", fontStyle: "italic" },
    { tag: [t.number, t.bool, t.null], color: "#ff9e64" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#7aa2f7" },
    { tag: [t.typeName, t.className, t.namespace], color: "#2ac3de" },
    { tag: [t.propertyName, t.attributeName], color: "#73daca" },
    { tag: [t.operator, t.punctuation], color: "#89ddff" },
    { tag: [t.variableName, t.definition(t.variableName)], color: "#c0caf5" },
    { tag: t.invalid, color: "#f7768e" },
  ],
})

/** Gruvbox Dark — Pavel Pertsev's retro-groove palette (medium contrast). */
const gruvboxDark = createTheme({
  theme: "dark",
  settings: {
    background: "#282828",
    foreground: "#ebdbb2",
    caret: "#ebdbb2",
    selection: "#3c3836",
    selectionMatch: "#3c3836",
    lineHighlight: "#32302f",
    gutterBackground: "#282828",
    gutterForeground: "#7c6f64",
  },
  styles: [
    { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "#fb4934" },
    { tag: [t.string, t.special(t.string)], color: "#b8bb26" },
    { tag: [t.comment, t.lineComment, t.blockComment], color: "#928374", fontStyle: "italic" },
    { tag: [t.number, t.bool, t.null], color: "#d3869b" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#b8bb26" },
    { tag: [t.typeName, t.className, t.namespace], color: "#fabd2f" },
    { tag: [t.propertyName, t.attributeName], color: "#83a598" },
    { tag: [t.operator, t.punctuation], color: "#8ec07c" },
    { tag: [t.variableName, t.definition(t.variableName)], color: "#ebdbb2" },
    { tag: t.invalid, color: "#fb4934" },
  ],
})

/** Nord — Arctic Code Studio's frost/aurora palette. */
const nord = createTheme({
  theme: "dark",
  settings: {
    background: "#2e3440",
    foreground: "#d8dee9",
    caret: "#d8dee9",
    selection: "#434c5e",
    selectionMatch: "#434c5e",
    lineHighlight: "#3b4252",
    gutterBackground: "#2e3440",
    gutterForeground: "#4c566a",
  },
  styles: [
    { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "#81a1c1" },
    { tag: [t.string, t.special(t.string)], color: "#a3be8c" },
    { tag: [t.comment, t.lineComment, t.blockComment], color: "#616e88", fontStyle: "italic" },
    { tag: [t.number, t.bool, t.null], color: "#b48ead" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#88c0d0" },
    { tag: [t.typeName, t.className, t.namespace], color: "#8fbcbb" },
    { tag: [t.propertyName, t.attributeName], color: "#d8dee9" },
    { tag: [t.operator, t.punctuation], color: "#81a1c1" },
    { tag: [t.variableName, t.definition(t.variableName)], color: "#d8dee9" },
    { tag: t.invalid, color: "#bf616a" },
  ],
})

/** Solarized Light — Ethan Schoonover's low-contrast light palette. */
const solarizedLight = createTheme({
  theme: "light",
  settings: {
    background: "#fdf6e3",
    foreground: "#657b83",
    caret: "#586e75",
    selection: "#eee8d5",
    selectionMatch: "#eee8d5",
    lineHighlight: "#eee8d5",
    gutterBackground: "#fdf6e3",
    gutterForeground: "#93a1a1",
  },
  styles: [
    { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "#859900" },
    { tag: [t.string, t.special(t.string)], color: "#2aa198" },
    { tag: [t.comment, t.lineComment, t.blockComment], color: "#93a1a1", fontStyle: "italic" },
    { tag: [t.number, t.bool, t.null], color: "#d33682" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#268bd2" },
    { tag: [t.typeName, t.className, t.namespace], color: "#b58900" },
    { tag: [t.propertyName, t.attributeName], color: "#268bd2" },
    { tag: [t.operator, t.punctuation], color: "#586e75" },
    { tag: [t.variableName, t.definition(t.variableName)], color: "#657b83" },
    { tag: t.invalid, color: "#dc322f" },
  ],
})

/** Catppuccin Latte — the warm light variant of the Catppuccin palette. */
const catppuccinLatte = createTheme({
  theme: "light",
  settings: {
    background: "#eff1f5",
    foreground: "#4c4f69",
    caret: "#dc8a78",
    selection: "#ccd0da",
    selectionMatch: "#ccd0da",
    lineHighlight: "#e6e9ef",
    gutterBackground: "#eff1f5",
    gutterForeground: "#8c8fa1",
  },
  styles: [
    { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "#8839ef" },
    { tag: [t.string, t.special(t.string)], color: "#40a02b" },
    { tag: [t.comment, t.lineComment, t.blockComment], color: "#9ca0b0", fontStyle: "italic" },
    { tag: [t.number, t.bool, t.null], color: "#fe640b" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#1e66f5" },
    { tag: [t.typeName, t.className, t.namespace], color: "#df8e1d" },
    { tag: [t.propertyName, t.attributeName], color: "#ea76cb" },
    { tag: [t.operator, t.punctuation], color: "#04a5e5" },
    { tag: [t.variableName, t.definition(t.variableName)], color: "#4c4f69" },
    { tag: t.invalid, color: "#d20f39" },
  ],
})

/** GitHub Light — GitHub's default light syntax palette. */
const githubLight = createTheme({
  theme: "light",
  settings: {
    background: "#ffffff",
    foreground: "#24292e",
    caret: "#044289",
    selection: "#c8e1ff",
    selectionMatch: "#c8e1ff",
    lineHighlight: "#f6f8fa",
    gutterBackground: "#ffffff",
    gutterForeground: "#6e7781",
  },
  styles: [
    { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "#d73a49" },
    { tag: [t.string, t.special(t.string)], color: "#032f62" },
    { tag: [t.comment, t.lineComment, t.blockComment], color: "#6a737d", fontStyle: "italic" },
    { tag: [t.number, t.bool, t.null], color: "#005cc5" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#6f42c1" },
    { tag: [t.typeName, t.className, t.namespace], color: "#6f42c1" },
    { tag: [t.propertyName, t.attributeName], color: "#005cc5" },
    { tag: [t.operator, t.punctuation], color: "#24292e" },
    { tag: [t.variableName, t.definition(t.variableName)], color: "#e36209" },
    { tag: t.invalid, color: "#cb2431" },
  ],
})

/** Tokyo Night Day — enkia's light "day" variant of the Tokyo Night palette. */
const tokyoNightDay = createTheme({
  theme: "light",
  settings: {
    background: "#e1e2e7",
    foreground: "#3760bf",
    caret: "#3760bf",
    selection: "#b7c1e3",
    selectionMatch: "#b7c1e3",
    lineHighlight: "#d2d4de",
    gutterBackground: "#e1e2e7",
    gutterForeground: "#848cb5",
  },
  styles: [
    { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "#9854f1" },
    { tag: [t.string, t.special(t.string)], color: "#587539" },
    { tag: [t.comment, t.lineComment, t.blockComment], color: "#848cb5", fontStyle: "italic" },
    { tag: [t.number, t.bool, t.null], color: "#b15c00" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#2e7de9" },
    { tag: [t.typeName, t.className, t.namespace], color: "#007197" },
    { tag: [t.propertyName, t.attributeName], color: "#118c74" },
    { tag: [t.operator, t.punctuation], color: "#006a83" },
    { tag: [t.variableName, t.definition(t.variableName)], color: "#3760bf" },
    { tag: t.invalid, color: "#f52a65" },
  ],
})

interface CompactPalette {
  background: string
  foreground: string
  muted: string
  selection: string
  line: string
  keyword: string
  string: string
  number: string
  function: string
  type: string
  property: string
  operator: string
  invalid: string
}

function compactTheme(palette: CompactPalette, mode: "light" | "dark"): Extension {
  return createTheme({
    theme: mode,
    settings: {
      background: palette.background,
      foreground: palette.foreground,
      caret: palette.foreground,
      selection: palette.selection,
      selectionMatch: palette.selection,
      lineHighlight: palette.line,
      gutterBackground: palette.background,
      gutterForeground: palette.muted,
    },
    styles: [
      { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: palette.keyword },
      { tag: [t.string, t.special(t.string)], color: palette.string },
      {
        tag: [t.comment, t.lineComment, t.blockComment],
        color: palette.muted,
        fontStyle: "italic",
      },
      { tag: [t.number, t.bool, t.null], color: palette.number },
      {
        tag: [t.function(t.variableName), t.function(t.propertyName)],
        color: palette.function,
      },
      { tag: [t.typeName, t.className, t.namespace], color: palette.type },
      { tag: [t.propertyName, t.attributeName], color: palette.property },
      { tag: [t.operator, t.punctuation], color: palette.operator },
      { tag: [t.variableName, t.definition(t.variableName)], color: palette.foreground },
      { tag: t.invalid, color: palette.invalid },
    ],
  })
}

function compactDarkTheme(palette: CompactPalette): Extension {
  return compactTheme(palette, "dark")
}

function compactLightTheme(palette: CompactPalette): Extension {
  return compactTheme(palette, "light")
}

const dracula = compactDarkTheme({
  background: "#282a36",
  foreground: "#f8f8f2",
  muted: "#6272a4",
  selection: "#44475a",
  line: "#30323f",
  keyword: "#ff79c6",
  string: "#f1fa8c",
  number: "#bd93f9",
  function: "#50fa7b",
  type: "#8be9fd",
  property: "#ffb86c",
  operator: "#ff79c6",
  invalid: "#ff5555",
})

const monokai = compactDarkTheme({
  background: "#272822",
  foreground: "#f8f8f2",
  muted: "#75715e",
  selection: "#49483e",
  line: "#30302a",
  keyword: "#f92672",
  string: "#e6db74",
  number: "#ae81ff",
  function: "#a6e22e",
  type: "#66d9ef",
  property: "#fd971f",
  operator: "#f92672",
  invalid: "#f44747",
})

const githubDark = compactDarkTheme({
  background: "#0d1117",
  foreground: "#c9d1d9",
  muted: "#8b949e",
  selection: "#264f78",
  line: "#161b22",
  keyword: "#ff7b72",
  string: "#a5d6ff",
  number: "#79c0ff",
  function: "#d2a8ff",
  type: "#ffa657",
  property: "#79c0ff",
  operator: "#ff7b72",
  invalid: "#f85149",
})

const catppuccinMocha = compactDarkTheme({
  background: "#1e1e2e",
  foreground: "#cdd6f4",
  muted: "#6c7086",
  selection: "#45475a",
  line: "#252536",
  keyword: "#cba6f7",
  string: "#a6e3a1",
  number: "#fab387",
  function: "#89b4fa",
  type: "#f9e2af",
  property: "#f5c2e7",
  operator: "#89dceb",
  invalid: "#f38ba8",
})

const oneLight = compactLightTheme({
  background: "#fafafa",
  foreground: "#383a42",
  muted: "#a0a1a7",
  selection: "#dbe9f9",
  line: "#f0f0f0",
  keyword: "#a626a4",
  string: "#50a14f",
  number: "#986801",
  function: "#4078f2",
  type: "#c18401",
  property: "#e45649",
  operator: "#0184bc",
  invalid: "#e45649",
})

const gruvboxLight = compactLightTheme({
  background: "#fbf1c7",
  foreground: "#3c3836",
  muted: "#928374",
  selection: "#ebdbb2",
  line: "#f2e5bc",
  keyword: "#9d0006",
  string: "#79740e",
  number: "#8f3f71",
  function: "#427b58",
  type: "#b57614",
  property: "#076678",
  operator: "#af3a03",
  invalid: "#9d0006",
})

const nordLight = compactLightTheme({
  background: "#eceff4",
  foreground: "#2e3440",
  muted: "#7b88a1",
  selection: "#d8dee9",
  line: "#e5e9f0",
  keyword: "#5e81ac",
  string: "#a35f5f",
  number: "#b48ead",
  function: "#5e81ac",
  type: "#2e8b8b",
  property: "#d08770",
  operator: "#5e81ac",
  invalid: "#bf616a",
})

const draculaLight = compactLightTheme({
  background: "#f8f8f2",
  foreground: "#282a36",
  muted: "#787a91",
  selection: "#e5e5de",
  line: "#f0f0e9",
  keyword: "#a626a4",
  string: "#718c00",
  number: "#986801",
  function: "#4078f2",
  type: "#0184bc",
  property: "#c18401",
  operator: "#a626a4",
  invalid: "#e45649",
})

/**
 * The sixteen selectable themes in picker order, with light palettes first and dark
 * palettes second. The array order *is* the grouped picker order, and each
 * label already carries its "(Light)"/"(Dark)" suffix.
 */
export const EDITOR_THEMES: readonly EditorTheme[] = [
  { id: "solarized-light", label: "Solarized (Light)", mode: "light", extension: solarizedLight },
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte (Light)",
    mode: "light",
    extension: catppuccinLatte,
  },
  { id: "github-light", label: "GitHub (Light)", mode: "light", extension: githubLight },
  { id: "tokyo-night-day", label: "Tokyo Night (Light)", mode: "light", extension: tokyoNightDay },
  { id: "one-light", label: "Atom One (Light)", mode: "light", extension: oneLight },
  { id: "gruvbox-light", label: "Gruvbox (Light)", mode: "light", extension: gruvboxLight },
  { id: "nord-light", label: "Nord (Light)", mode: "light", extension: nordLight },
  { id: "dracula-light", label: "Dracula (Light)", mode: "light", extension: draculaLight },
  { id: "one-dark", label: "Atom One (Dark)", mode: "dark", extension: oneDark },
  { id: "tokyo-night", label: "Tokyo Night (Dark)", mode: "dark", extension: tokyoNight },
  { id: "gruvbox-dark", label: "Gruvbox (Dark)", mode: "dark", extension: gruvboxDark },
  { id: "nord", label: "Nord (Dark)", mode: "dark", extension: nord },
  { id: "dracula", label: "Dracula (Dark)", mode: "dark", extension: dracula },
  { id: "monokai", label: "Monokai (Dark)", mode: "dark", extension: monokai },
  { id: "github-dark", label: "GitHub (Dark)", mode: "dark", extension: githubDark },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha (Dark)",
    mode: "dark",
    extension: catppuccinMocha,
  },
]

/** Id of any registered editor theme (kept as a string in the DB, narrowed here). */
export type EditorThemeId = (typeof EDITOR_THEMES)[number]["id"]

/**
 * Resolve a stored theme id to its CodeMirror extension. A known id resolves to its
 * own palette; an undefined/empty/unknown or legacy id (rows predating this field,
 * the retired "default" sentinel, or an id removed from the registry) falls back to
 * the {@link DEFAULT_EDITOR_THEME_ID} theme so the editor always renders a defined,
 * styled palette rather than failing or going unstyled.
 */
export function allEditorThemes(customThemes: ImportedEditorTheme[]): readonly EditorTheme[] {
  return [...EDITOR_THEMES, ...customThemes.map(importedEditorTheme)]
}

export function editorThemeExtension(
  id: string | undefined,
  customThemes?: ImportedEditorTheme[],
): Extension {
  if (id === "pi-lab-light") return piLabLight
  if (id === "pi-lab-dark") return piLabDark
  return (
    (
      allEditorThemes(customThemes ?? []).find((theme) => theme.id === id) ??
      EDITOR_THEMES.find((theme) => theme.id === DEFAULT_EDITOR_THEME_ID)
    )?.extension ?? []
  )
}

function importedEditorTheme(theme: ImportedEditorTheme): EditorTheme {
  return {
    id: theme.id,
    label: `${theme.name} (${theme.mode === "light" ? "Light" : "Dark"})`,
    mode: theme.mode,
    custom: true,
    extension: createTheme({
      theme: theme.mode,
      settings: {
        background: theme.colors.background,
        foreground: theme.colors.foreground,
        caret: theme.colors.caret ?? theme.colors.foreground,
        selection: theme.colors.selection,
        selectionMatch: theme.colors.selectionMatch,
        lineHighlight: theme.colors.lineHighlight,
        gutterBackground: theme.colors.gutterBackground ?? theme.colors.background,
        gutterForeground: theme.colors.gutterForeground,
      },
      styles: theme.tokenColors.flatMap((rule) => {
        const tags = tagsForScopes(rule.scopes)
        if (tags.length === 0) return []
        const fontStyles = new Set(rule.fontStyle?.split(/\s+/u) ?? [])
        return [
          {
            tag: tags,
            color: rule.foreground,
            fontStyle: fontStyles.has("italic") ? "italic" : undefined,
            fontWeight: fontStyles.has("bold") ? "bold" : undefined,
            textDecoration: fontStyles.has("underline") ? "underline" : undefined,
          },
        ]
      }),
    }),
  }
}

function tagsForScopes(scopes: string[]): Tag[] {
  const tags = new Set<Tag>()
  for (const scope of scopes) {
    const mapped = tagForScope(scope.toLowerCase())
    if (mapped) tags.add(mapped)
  }
  return [...tags]
}

function tagForScope(scope: string): Tag | null {
  if (scope.includes("comment")) return t.comment
  if (scope.includes("string")) return t.string
  if (scope.includes("constant.numeric")) return t.number
  if (scope.includes("constant.language.boolean")) return t.bool
  if (scope.includes("constant.language.null")) return t.null
  if (scope.startsWith("keyword") || scope.startsWith("storage") || scope.includes("control")) {
    return t.keyword
  }
  if (scope.includes("function")) return t.function(t.variableName)
  if (scope.includes("class")) return t.className
  if (scope.includes("type") || scope.includes("namespace")) return t.typeName
  if (scope.includes("attribute")) return t.attributeName
  if (scope.includes("property") || scope.includes("object-literal.key")) return t.propertyName
  if (scope.includes("variable")) return t.variableName
  if (scope.includes("operator")) return t.operator
  if (scope.includes("punctuation")) return t.punctuation
  if (scope.includes("invalid")) return t.invalid
  return null
}
