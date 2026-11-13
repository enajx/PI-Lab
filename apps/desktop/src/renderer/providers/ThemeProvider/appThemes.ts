/** Color tokens every named theme sets, overriding globals.css. */
export const BASE_THEME_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "sidebar",
  "sidebar-foreground",
  "sidebar-border",
  "accent-brand",
] as const

/**
 * Tokens only a chosen accent sets: panel card borders, panel titles, headings,
 * selected items, and the icon of a hovered icon button. When unset, globals.css falls back to the color each place used
 * before these tokens existed, so other themes look the same.
 */
export const ACCENT_THEME_TOKENS = [
  "panel-border",
  "panel-title",
  "heading",
  "selected",
  "selected-foreground",
  "hover-foreground",
] as const

export const APP_THEME_TOKENS = [...BASE_THEME_TOKENS, ...ACCENT_THEME_TOKENS] as const

export type BaseThemeToken = (typeof BASE_THEME_TOKENS)[number]
export type AccentThemeToken = (typeof ACCENT_THEME_TOKENS)[number]
export type AppThemeToken = (typeof APP_THEME_TOKENS)[number]
export type ResolvedThemeMode = "dark" | "light"
/** Tokens to set on the root element; any token left out keeps the globals.css value. */
export type ThemeTokenSet = Partial<Record<AppThemeToken, string>>

interface Palette {
  background: string
  surface: string
  elevated: string
  hover: string
  sidebar: string
  border: string
  foreground: string
  subtext: string
  primary: string
  primaryForeground: string
  brand: string
  destructive: string
  destructiveForeground: string
}

/** One shade of an accent, for light or dark mode. */
export interface AccentColors {
  /** Panel card borders, titles, headings, selected items, buttons and links. */
  accent: string
  /** Second hue for editor syntax (functions, types, strings). */
  secondary: string
}

export interface AppTheme {
  id: string
  label: string
  /** Null for a dark-only theme; in Light mode the app then shows Default's light colors. */
  light: Palette | null
  dark: Palette
}

type PaletteValues = readonly [
  background: string,
  surface: string,
  elevated: string,
  hover: string,
  sidebar: string,
  border: string,
  foreground: string,
  subtext: string,
  primary: string,
  primaryForeground: string,
  brand: string,
  destructive: string,
  destructiveForeground: string,
]

function palette(values: PaletteValues): Palette {
  const [
    background,
    surface,
    elevated,
    hover,
    sidebar,
    border,
    foreground,
    subtext,
    primary,
    primaryForeground,
    brand,
    destructive,
    destructiveForeground,
  ] = values
  return {
    background,
    surface,
    elevated,
    hover,
    sidebar,
    border,
    foreground,
    subtext,
    primary,
    primaryForeground,
    brand,
    destructive,
    destructiveForeground,
  }
}

export const DEFAULT_APP_THEME_ID = "default"

export const APP_THEMES: readonly AppTheme[] = [
  {
    id: DEFAULT_APP_THEME_ID,
    label: "Default",
    light: palette([
      "#ffffff",
      "#ffffff",
      "#f0efed",
      "#eae9e6",
      "#f3f3f3",
      "#e4e3e0",
      "#353432",
      "#777572",
      "#4d4c49",
      "#faf9f7",
      "#d17a32",
      "#c74336",
      "#faf9f7",
    ]),
    dark: palette([
      "#2c2b29",
      "#343330",
      "#403f3b",
      "#494844",
      "#32312f",
      "#494844",
      "#e7e5e1",
      "#aaa7a2",
      "#e7e5e1",
      "#32312f",
      "#db8440",
      "#d65c4d",
      "#f2e8e6",
    ]),
  },
  {
    id: "nord",
    label: "Nord",
    light: palette([
      "#eceff4",
      "#e5e9f0",
      "#e5e9f0",
      "#d8dee9",
      "#e5e9f0",
      "#d8dee9",
      "#2e3440",
      "#4c566a",
      "#5e81ac",
      "#eceff4",
      "#5e81ac",
      "#bf616a",
      "#eceff4",
    ]),
    dark: palette([
      "#2e3440",
      "#3b4252",
      "#3b4252",
      "#434c5e",
      "#2b303b",
      "#434c5e",
      "#d8dee9",
      "#8d97ab",
      "#88c0d0",
      "#2e3440",
      "#81a1c1",
      "#bf616a",
      "#eceff4",
    ]),
  },
  {
    id: "one",
    label: "One Dark / One Light",
    light: palette([
      "#fafafa",
      "#ffffff",
      "#f0f0f1",
      "#e5e5e6",
      "#eaeaeb",
      "#dbdbdc",
      "#383a42",
      "#696c77",
      "#4078f2",
      "#fafafa",
      "#a626a4",
      "#e45649",
      "#fafafa",
    ]),
    dark: palette([
      "#282c34",
      "#2c313a",
      "#333842",
      "#3e4451",
      "#21252b",
      "#3e4451",
      "#abb2bf",
      "#7f848e",
      "#61afef",
      "#282c34",
      "#c678dd",
      "#e06c75",
      "#282c34",
    ]),
  },
  {
    id: "github",
    label: "GitHub",
    light: palette([
      "#ffffff",
      "#ffffff",
      "#f6f8fa",
      "#eaeef2",
      "#f6f8fa",
      "#d0d7de",
      "#1f2328",
      "#656d76",
      "#0969da",
      "#ffffff",
      "#8250df",
      "#cf222e",
      "#ffffff",
    ]),
    dark: palette([
      "#0d1117",
      "#161b22",
      "#21262d",
      "#30363d",
      "#010409",
      "#30363d",
      "#e6edf3",
      "#8d96a0",
      "#4493f8",
      "#0d1117",
      "#a371f7",
      "#f85149",
      "#0d1117",
    ]),
  },
  {
    id: "graphite",
    label: "Graphite",
    light: palette([
      "#f4f4f5",
      "#ffffff",
      "#e9e9eb",
      "#e1e1e4",
      "#ececee",
      "#d6d6da",
      "#1d1d20",
      "#6b6b72",
      "#3a3a40",
      "#f4f4f5",
      "#3b82f6",
      "#d64545",
      "#ffffff",
    ]),
    dark: palette([
      "#1c1c1e",
      "#232326",
      "#2c2c2f",
      "#36363a",
      "#18181a",
      "#38383c",
      "#e4e4e7",
      "#9a9aa2",
      "#e4e4e7",
      "#1c1c1e",
      "#5b9cff",
      "#f06a6a",
      "#1c1c1e",
    ]),
  },
  {
    id: "pale-slate",
    label: "Pale Slate",
    light: palette([
      "#eef1f5",
      "#f5f7fa",
      "#e3e8ee",
      "#d9dfe7",
      "#e6eaf0",
      "#d3dae3",
      "#2f3a4a",
      "#6b7789",
      "#5b6b82",
      "#f5f7fa",
      "#6f8fb8",
      "#b85c5c",
      "#f5f7fa",
    ]),
    dark: palette([
      "#2a313b",
      "#313945",
      "#38414e",
      "#414b59",
      "#262c35",
      "#434d5b",
      "#d8dee7",
      "#9aa5b4",
      "#b4c0cf",
      "#2a313b",
      "#8fa9cc",
      "#d88a8a",
      "#2a313b",
    ]),
  },
  {
    id: "slate",
    label: "Slate",
    light: palette([
      "#f8fafc",
      "#ffffff",
      "#f1f5f9",
      "#e2e8f0",
      "#f1f5f9",
      "#e2e8f0",
      "#0f172a",
      "#64748b",
      "#334155",
      "#f8fafc",
      "#0d9488",
      "#dc2626",
      "#ffffff",
    ]),
    dark: palette([
      "#1e1e1e",
      "#242424",
      "#2c2c2c",
      "#353535",
      "#1a1a1a",
      "#383838",
      "#e6e6e6",
      "#9a9a9a",
      "#e6e6e6",
      "#1e1e1e",
      "#bdbdbd",
      "#f0f0f0",
      "#1e1e1e",
    ]),
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    light: null,
    dark: palette([
      "#1a1b26",
      "#1f2335",
      "#292e42",
      "#2f3549",
      "#16161e",
      "#3b4261",
      "#c0caf5",
      "#565f89",
      "#7aa2f7",
      "#1a1b26",
      "#bb9af7",
      "#f7768e",
      "#1a1b26",
    ]),
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    light: null,
    dark: palette([
      "#1e1e2e",
      "#181825",
      "#313244",
      "#45475a",
      "#181825",
      "#313244",
      "#cdd6f4",
      "#a6adc8",
      "#cba6f7",
      "#1e1e2e",
      "#89b4fa",
      "#f38ba8",
      "#1e1e2e",
    ]),
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    light: null,
    dark: palette([
      "#191724",
      "#1f1d2e",
      "#26233a",
      "#403d52",
      "#1f1d2e",
      "#26233a",
      "#e0def4",
      "#908caa",
      "#c4a7e7",
      "#191724",
      "#ebbcba",
      "#eb6f92",
      "#191724",
    ]),
  },
  {
    id: "dracula",
    label: "Dracula",
    light: null,
    dark: palette([
      "#282a36",
      "#343746",
      "#343746",
      "#44475a",
      "#21222c",
      "#44475a",
      "#f8f8f2",
      "#6272a4",
      "#bd93f9",
      "#282a36",
      "#ff79c6",
      "#ff5555",
      "#282a36",
    ]),
  },
  {
    id: "material",
    label: "Mackerel",
    light: null,
    dark: palette([
      "#263238",
      "#2c3b41",
      "#314549",
      "#3c5058",
      "#1e272c",
      "#37474f",
      "#eeffff",
      "#b0bec5",
      "#80cbc4",
      "#263238",
      "#c792ea",
      "#ff5370",
      "#263238",
    ]),
  },
  {
    id: "zenburn",
    label: "Sand Beige",
    light: null,
    dark: palette([
      "#3f3f3f",
      "#494949",
      "#4f4f4f",
      "#5f5f5f",
      "#383838",
      "#5f5f5f",
      "#dcdccc",
      "#9fafaf",
      "#f0dfaf",
      "#3f3f3f",
      "#8cd0d3",
      "#cc9393",
      "#3f3f3f",
    ]),
  },
  {
    id: "ascii-terminal",
    label: "Digital Rain",
    light: null,
    dark: palette([
      "#000000",
      "#050a05",
      "#0a140a",
      "#0f1f0f",
      "#000000",
      "#1a3a1a",
      "#33ff33",
      "#1fae1f",
      "#33ff33",
      "#000000",
      "#66ff66",
      "#ffb000",
      "#000000",
    ]),
  },
]

export function normalizeAppThemeId(themeId: string | null): string {
  return APP_THEMES.some(({ id }) => id === themeId)
    ? (themeId ?? DEFAULT_APP_THEME_ID)
    : DEFAULT_APP_THEME_ID
}

/** A preset accent with a shade tuned for light and for dark mode. */
export interface AppAccent {
  id: string
  label: string
  light: AccentColors
  dark: AccentColors
}

/** "Theme default": no accent, the theme looks as it is. */
export const DEFAULT_ACCENT_ID = "default"

export const APP_ACCENTS: readonly AppAccent[] = [
  {
    id: "neon-pink",
    label: "Neon Pink",
    light: { accent: "#c2347f", secondary: "#0e7490" },
    dark: { accent: "#ff9bd2", secondary: "#8fdcff" },
  },
  {
    id: "ember",
    label: "Ember",
    light: { accent: "#c4540f", secondary: "#8a6400" },
    dark: { accent: "#ff9a4d", secondary: "#e9c46a" },
  },
  {
    id: "lagoon",
    label: "Lagoon",
    light: { accent: "#0f7a6e", secondary: "#b4532a" },
    dark: { accent: "#4fd6c4", secondary: "#f4a98a" },
  },
  {
    id: "acid-lime",
    label: "Acid Lime",
    light: { accent: "#4f7d0c", secondary: "#1f6fb2" },
    dark: { accent: "#bff25a", secondary: "#8cc8ff" },
  },
  {
    id: "ultraviolet",
    label: "Ultraviolet",
    light: { accent: "#6a3fd4", secondary: "#9a5b00" },
    dark: { accent: "#b8a1ff", secondary: "#ffd27a" },
  },
  {
    id: "amber",
    label: "Amber",
    light: { accent: "#9a6700", secondary: "#b5452a" },
    dark: { accent: "#ffc247", secondary: "#ff8f6b" },
  },
  {
    id: "crimson",
    label: "Crimson",
    light: { accent: "#c01c30", secondary: "#8a5a1b" },
    dark: { accent: "#ff5f6d", secondary: "#f2c38f" },
  },
  {
    id: "glacier",
    label: "Glacier",
    light: { accent: "#0369a1", secondary: "#b0306f" },
    dark: { accent: "#66e3ff", secondary: "#ffa3d1" },
  },
  {
    id: "mint",
    label: "Mint",
    light: { accent: "#0f7a4c", secondary: "#6b4fc8" },
    dark: { accent: "#7ef0b4", secondary: "#c9b5ff" },
  },
  {
    id: "cobalt",
    label: "Cobalt",
    light: { accent: "#2453c9", secondary: "#a3530b" },
    dark: { accent: "#7aa7ff", secondary: "#ffb86b" },
  },
]

const CUSTOM_ACCENT = /^#[0-9a-f]{6}$/u

/** A preset accent id, a custom `#rrggbb` color, or Theme default for anything else. */
export function normalizeAccentId(accentId: string | null): string {
  const value = accentId?.toLowerCase() ?? DEFAULT_ACCENT_ID
  if (CUSTOM_ACCENT.test(value)) return value
  return APP_ACCENTS.some(({ id }) => id === value) ? value : DEFAULT_ACCENT_ID
}

/**
 * The accent shade for a mode: a preset's tuned shade, or for a custom color the
 * color itself, darkened (light) or lightened (dark) only as far as text needs,
 * with the second syntax color at a hue 150 degrees away.
 */
function accentShade(accentId: string, mode: ResolvedThemeMode): AccentColors | null {
  const normalized = normalizeAccentId(accentId)
  if (normalized === DEFAULT_ACCENT_ID) return null
  const preset = APP_ACCENTS.find(({ id }) => id === normalized)
  if (preset) return preset[mode]
  const reference = mode === "light" ? "#ffffff" : "#1c1c1c"
  return {
    accent: ensureContrast(reference, normalized),
    secondary: ensureContrast(reference, rotateHue(normalized, 150)),
  }
}

/**
 * The theme and palette the app shows for a mode: the theme's own, or Default's
 * for an unknown id or a dark-only theme in Light mode.
 */
function shownPalette(
  themeId: string,
  mode: ResolvedThemeMode,
): { isDefault: boolean; colors: Palette } {
  const theme = APP_THEMES.find(({ id }) => id === normalizeAppThemeId(themeId))
  const colors = theme?.[mode]
  if (theme && colors) return { isDefault: theme.id === DEFAULT_APP_THEME_ID, colors }
  const fallback = APP_THEMES[0]?.[mode]
  if (!fallback) throw new Error("Default theme has no palette for this mode")
  return { isDefault: true, colors: fallback }
}

/**
 * The tokens to set for a theme and accent. Default with Theme default sets none
 * (globals.css applies). Default with an accent sets only the accent colors.
 */
export function resolveAppThemeTokens(
  themeId: string,
  mode: ResolvedThemeMode,
  accentId: string,
): ThemeTokenSet | null {
  const { isDefault, colors } = shownPalette(themeId, mode)
  const shade = accentShade(accentId, mode)
  const base = isDefault ? {} : buildTokenSet(colors)
  if (!shade) return isDefault ? null : base
  return { ...base, ...accentTokens(colors, shade.accent) }
}

/** Code editor colors for a chosen accent; null for Theme default, which keeps the editor theme. */
export interface AccentEditorColors {
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

export function accentEditorColors(
  themeId: string,
  mode: ResolvedThemeMode,
  accentId: string,
): AccentEditorColors | null {
  const shade = accentShade(accentId, mode)
  if (!shade) return null
  const { colors } = shownPalette(themeId, mode)
  const { accent, secondary } = shade
  const background = colors.background
  const readable = (color: string) => readableOn([background], color)
  return {
    background,
    foreground: readable(colors.foreground),
    muted: colors.subtext,
    selection: blend(background, accent, 0.28),
    line: blend(background, colors.foreground, 0.04),
    keyword: accentText(colors, accent),
    string: readable(blend(secondary, colors.foreground, 0.45)),
    number: readable(blend(accent, colors.foreground, 0.4)),
    function: readable(secondary),
    type: readable(secondary),
    property: readable(blend(accent, colors.foreground, 0.6)),
    operator: colors.subtext,
    invalid: readable(colors.destructive),
  }
}

export function appThemeSwatch(
  theme: AppTheme,
  mode: ResolvedThemeMode,
): readonly { id: string; color: string }[] {
  // A dark-only theme shows its dark colors in either mode.
  const colors = theme[mode] ?? theme.dark
  return [
    { id: "background", color: colors.background },
    { id: "sidebar", color: colors.sidebar },
    { id: "primary", color: colors.primary },
    { id: "hover", color: colors.hover },
    { id: "brand", color: colors.brand },
  ]
}

function buildTokenSet(colors: Palette): ThemeTokenSet {
  const foreground = ensureContrast(colors.background, colors.foreground)
  return {
    background: colors.background,
    foreground,
    card: colors.surface,
    "card-foreground": ensureContrast(colors.surface, foreground),
    popover: colors.surface,
    "popover-foreground": ensureContrast(colors.surface, foreground),
    primary: colors.primary,
    "primary-foreground": ensureContrast(colors.primary, colors.primaryForeground),
    secondary: colors.elevated,
    "secondary-foreground": ensureContrast(colors.elevated, foreground),
    muted: colors.elevated,
    "muted-foreground": ensureContrast(colors.elevated, colors.subtext),
    accent: colors.hover,
    "accent-foreground": ensureContrast(colors.hover, foreground),
    destructive: colors.destructive,
    "destructive-foreground": ensureContrast(colors.destructive, colors.destructiveForeground),
    border: colors.border,
    input: colors.border,
    ring: colors.brand,
    sidebar: colors.sidebar,
    "sidebar-foreground": ensureContrast(colors.sidebar, foreground),
    "sidebar-border": colors.border,
    "accent-brand": colors.brand,
  }
}

/**
 * The accent-colored tokens: card borders, buttons and the focus ring use the
 * accent as given; text uses it as far as it stays readable on its surfaces.
 */
function accentTokens(colors: Palette, accent: string): ThemeTokenSet {
  const text = accentText(colors, accent)
  const selected = blend(colors.sidebar, accent, 0.16)
  return {
    primary: accent,
    "primary-foreground": ensureContrast(accent, colors.background),
    ring: accent,
    "panel-border": accent,
    "panel-title": text,
    heading: text,
    selected,
    "selected-foreground": readableOn([selected, colors.background, colors.surface], accent),
    // Icon and text of a hovered icon button.
    "hover-foreground": readableOn(
      [colors.background, colors.surface, colors.sidebar, colors.hover],
      accent,
    ),
  }
}

/** The accent as text on the window, card and sidebar surfaces. */
function accentText(colors: Palette, accent: string): string {
  return readableOn([colors.background, colors.surface, colors.sidebar], accent)
}

interface Rgb {
  red: number
  green: number
  blue: number
}

function parseHex(color: string): Rgb {
  const value = color.slice(1)
  return {
    red: Number.parseInt(value.slice(0, 2), 16),
    green: Number.parseInt(value.slice(2, 4), 16),
    blue: Number.parseInt(value.slice(4, 6), 16),
  }
}

function luminance(color: string): number {
  const { red, green, blue } = parseHex(color)
  const channel = (value: number) => {
    const normalized = value / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
}

export function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(luminance(first), luminance(second))
  const darker = Math.min(luminance(first), luminance(second))
  return (lighter + 0.05) / (darker + 0.05)
}

function toHex({ red, green, blue }: Rgb): string {
  const channel = (value: number) => Math.round(value).toString(16).padStart(2, "0")
  return `#${channel(red)}${channel(green)}${channel(blue)}`
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    red: from.red + (to.red - from.red) * amount,
    green: from.green + (to.green - from.green) * amount,
    blue: from.blue + (to.blue - from.blue) * amount,
  }
}

/** The same color with its hue turned by `degrees`, keeping saturation and lightness. */
function rotateHue(color: string, degrees: number): string {
  const { red, green, blue } = parseHex(color)
  const [r, g, b] = [red / 255, green / 255, blue / 255]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const lightness = (max + min) / 2
  const delta = max - min
  if (delta === 0) return color
  const saturation = delta / (1 - Math.abs(2 * lightness - 1))
  const sector =
    max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  const hue = (((sector * 60 + degrees) % 360) + 360) % 360
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = lightness - chroma / 2
  const [r1, g1, b1] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x]
  return toHex({ red: (r1 + m) * 255, green: (g1 + m) * 255, blue: (b1 + m) * 255 })
}

function blend(from: string, to: string, amount: number): string {
  return toHex(mix(parseHex(from), parseHex(to), amount))
}

/** Nudge a color until it reads at normal-text contrast on every given background. */
function readableOn(backgrounds: readonly string[], preferred: string): string {
  let color = preferred
  for (let pass = 0; pass < 3; pass += 1) {
    for (const background of backgrounds) color = ensureContrast(background, color)
  }
  for (const background of backgrounds) {
    if (contrastRatio(background, color) < 4.5) {
      throw new Error(`No readable color for ${preferred} on ${backgrounds.join(", ")}`)
    }
  }
  return color
}

/**
 * Preserve each palette's foreground hue when possible, nudging it only as far
 * toward black or white as needed for normal-size text contrast.
 */
function ensureContrast(background: string, preferred: string): string {
  if (contrastRatio(background, preferred) >= 4.5) return preferred
  const target =
    contrastRatio(background, "#000000") >= contrastRatio(background, "#ffffff")
      ? "#000000"
      : "#ffffff"
  const from = parseHex(preferred)
  const to = parseHex(target)
  let low = 0
  let high = 1
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const middle = (low + high) / 2
    if (contrastRatio(background, toHex(mix(from, to, middle))) >= 4.5) high = middle
    else low = middle
  }
  return toHex(mix(from, to, high))
}
