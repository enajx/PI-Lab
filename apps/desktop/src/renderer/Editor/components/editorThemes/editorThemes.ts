import type { Extension } from "@codemirror/state"
import { tags as t } from "@lezer/highlight"
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
 * The registry holds exactly eight curated palettes — four light, then four dark —
 * grouped light-first in the Settings picker, with each label suffixed "(Light)" or
 * "(Dark)". The stored id is a plain string (see `EditorSettings.editorTheme` in
 * `@skipper/local-db`) so the DB never couples to this renderer-only registry.
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
}

/**
 * The id used when no theme has been picked yet, or when a stored/legacy id is no
 * longer in the curated set. It is a *real* member of {@link EDITOR_THEMES} (a light
 * theme) and doubles as the fallback for both {@link editorThemeExtension} and the
 * Settings picker, so the editor always renders a defined, styled theme rather than
 * an unstyled buffer.
 */
export const DEFAULT_EDITOR_THEME_ID = "solarized-light"

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

/**
 * The eight selectable themes in picker order: the four light palettes first, then
 * the four dark ones. The array order *is* the grouped picker order, and each
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
  { id: "one-dark", label: "Atom One (Dark)", mode: "dark", extension: oneDark },
  { id: "tokyo-night", label: "Tokyo Night (Dark)", mode: "dark", extension: tokyoNight },
  { id: "gruvbox-dark", label: "Gruvbox (Dark)", mode: "dark", extension: gruvboxDark },
  { id: "nord", label: "Nord (Dark)", mode: "dark", extension: nord },
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
export function editorThemeExtension(id: string | undefined): Extension {
  return (
    (
      EDITOR_THEMES.find((theme) => theme.id === id) ??
      EDITOR_THEMES.find((theme) => theme.id === DEFAULT_EDITOR_THEME_ID)
    )?.extension ?? []
  )
}
