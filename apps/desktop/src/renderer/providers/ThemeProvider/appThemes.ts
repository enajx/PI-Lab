export const APP_THEME_TOKENS = [
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

export type AppThemeToken = (typeof APP_THEME_TOKENS)[number]
export type ResolvedThemeMode = "dark" | "light"
export type ThemeTokenSet = Record<AppThemeToken, string>

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

export interface AppTheme {
  id: string
  label: string
  light: Palette
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
    id: "tokyo-night",
    label: "Tokyo Night",
    light: palette([
      "#e1e2e7",
      "#e9e9ed",
      "#d0d5e3",
      "#c4c8da",
      "#d0d5e3",
      "#a8aecb",
      "#3760bf",
      "#848cb5",
      "#2e7de9",
      "#e1e2e7",
      "#9854f1",
      "#f52a65",
      "#e1e2e7",
    ]),
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
    light: palette([
      "#eff1f5",
      "#e6e9ef",
      "#ccd0da",
      "#bcc0cc",
      "#e6e9ef",
      "#ccd0da",
      "#4c4f69",
      "#6c6f85",
      "#8839ef",
      "#eff1f5",
      "#1e66f5",
      "#d20f39",
      "#eff1f5",
    ]),
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
    id: "gruvbox",
    label: "Gruvbox",
    light: palette([
      "#fbf1c7",
      "#f2e5bc",
      "#ebdbb2",
      "#d5c4a1",
      "#f2e5bc",
      "#d5c4a1",
      "#3c3836",
      "#7c6f64",
      "#b57614",
      "#fbf1c7",
      "#af3a03",
      "#9d0006",
      "#fbf1c7",
    ]),
    dark: palette([
      "#282828",
      "#3c3836",
      "#3c3836",
      "#504945",
      "#1d2021",
      "#504945",
      "#ebdbb2",
      "#a89984",
      "#fabd2f",
      "#282828",
      "#fe8019",
      "#fb4934",
      "#fbf1c7",
    ]),
  },
  {
    id: "solarized",
    label: "Solarized",
    light: palette([
      "#fdf6e3",
      "#eee8d5",
      "#eee8d5",
      "#e6dfc8",
      "#eee8d5",
      "#ddd6c1",
      "#657b83",
      "#93a1a1",
      "#268bd2",
      "#fdf6e3",
      "#b58900",
      "#dc322f",
      "#fdf6e3",
    ]),
    dark: palette([
      "#002b36",
      "#073642",
      "#073642",
      "#0a4856",
      "#00252e",
      "#103b48",
      "#93a1a1",
      "#586e75",
      "#268bd2",
      "#002b36",
      "#b58900",
      "#dc322f",
      "#fdf6e3",
    ]),
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    light: palette([
      "#faf4ed",
      "#fffaf3",
      "#f2e9e1",
      "#dfdad9",
      "#fffaf3",
      "#f2e9e1",
      "#575279",
      "#797593",
      "#907aa9",
      "#faf4ed",
      "#d7827e",
      "#b4637a",
      "#faf4ed",
    ]),
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
    id: "everforest",
    label: "Everforest",
    light: palette([
      "#fffbef",
      "#f8f5e4",
      "#f8f5e4",
      "#f2efdf",
      "#f2efdf",
      "#e8e5d5",
      "#5c6a72",
      "#829181",
      "#8da101",
      "#fffbef",
      "#35a77c",
      "#f85552",
      "#fffbef",
    ]),
    dark: palette([
      "#2d353b",
      "#343f44",
      "#343f44",
      "#3d484d",
      "#232a2e",
      "#3d484d",
      "#d3c6aa",
      "#9da9a0",
      "#a7c080",
      "#2d353b",
      "#83c092",
      "#e67e80",
      "#2d353b",
    ]),
  },
  {
    id: "dracula",
    label: "Dracula",
    light: palette([
      "#fffbeb",
      "#f6f2e4",
      "#e8e4d5",
      "#dfdbc9",
      "#f6f2e4",
      "#d6d2c0",
      "#1f1f1f",
      "#6c664b",
      "#644ac9",
      "#fffbeb",
      "#a3144d",
      "#cb3a2a",
      "#fffbeb",
    ]),
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
]

export function normalizeAppThemeId(themeId: string | null): string {
  return APP_THEMES.some(({ id }) => id === themeId)
    ? (themeId ?? DEFAULT_APP_THEME_ID)
    : DEFAULT_APP_THEME_ID
}

export function resolveAppThemeTokens(
  themeId: string,
  mode: ResolvedThemeMode,
): ThemeTokenSet | null {
  const normalizedId = normalizeAppThemeId(themeId)
  if (normalizedId === DEFAULT_APP_THEME_ID) return null
  const theme = APP_THEMES.find(({ id }) => id === normalizedId)
  return theme ? buildTokenSet(theme[mode]) : null
}

export function appThemeSwatch(
  theme: AppTheme,
  mode: ResolvedThemeMode,
): readonly { id: string; color: string }[] {
  const colors = theme[mode]
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
