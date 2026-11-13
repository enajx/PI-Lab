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
 * Tokens only accent themes set: panel card borders, panel titles, headings, and
 * selected items. When unset, globals.css falls back to the color each place used
 * before these tokens existed, so other themes look the same.
 */
export const ACCENT_THEME_TOKENS = [
  "panel-border",
  "panel-title",
  "heading",
  "selected",
  "selected-foreground",
] as const

export const APP_THEME_TOKENS = [...BASE_THEME_TOKENS, ...ACCENT_THEME_TOKENS] as const

export type BaseThemeToken = (typeof BASE_THEME_TOKENS)[number]
export type AccentThemeToken = (typeof ACCENT_THEME_TOKENS)[number]
export type AppThemeToken = (typeof APP_THEME_TOKENS)[number]
export type ResolvedThemeMode = "dark" | "light"
export type ThemeTokenSet = Record<BaseThemeToken, string> &
  Partial<Record<AccentThemeToken, string>>
/** Release channel; only Alpha offers the trial and accent themes. */
export type AppChannel = "alpha" | "beta" | "stable"

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

/** The accent of an accent theme in one mode. */
interface AccentColors {
  /** Panel card borders, titles, headings, selected items, buttons and links. */
  accent: string
  /** Second hue for editor syntax (functions, types, strings). */
  secondary: string
}

export interface AppTheme {
  id: string
  label: string
  /** Offered on Beta and Stable; the others are Alpha-only until the user trims the list. */
  kept: boolean
  /** Set for accent themes, which color more of the interface and the code editor. */
  accent: { light: AccentColors; dark: AccentColors } | null
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

type AccentPaletteValues = readonly [
  background: string,
  surface: string,
  elevated: string,
  hover: string,
  sidebar: string,
  border: string,
  foreground: string,
  subtext: string,
  accent: string,
  secondary: string,
  destructive: string,
]

/**
 * Build an accent theme: a quiet base whose accent also serves as the primary
 * (buttons, links), focus ring and brand color.
 */
function accentTheme(
  id: string,
  label: string,
  modes: { light: AccentPaletteValues; dark: AccentPaletteValues },
): AppTheme {
  const build = (values: AccentPaletteValues): { colors: Palette; accent: AccentColors } => {
    const [
      background,
      surface,
      elevated,
      hover,
      sidebar,
      border,
      foreground,
      subtext,
      accent,
      secondary,
      destructive,
    ] = values
    return {
      colors: palette([
        background,
        surface,
        elevated,
        hover,
        sidebar,
        border,
        foreground,
        subtext,
        accent,
        background,
        accent,
        destructive,
        background,
      ]),
      accent: { accent, secondary },
    }
  }
  const light = build(modes.light)
  const dark = build(modes.dark)
  return {
    id,
    label,
    kept: false,
    accent: { light: light.accent, dark: dark.accent },
    light: light.colors,
    dark: dark.colors,
  }
}

export const DEFAULT_APP_THEME_ID = "default"

export const APP_THEMES: readonly AppTheme[] = [
  {
    id: DEFAULT_APP_THEME_ID,
    label: "Default",
    kept: true,
    accent: null,
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
    kept: true,
    accent: null,
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
    kept: true,
    accent: null,
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
    kept: true,
    accent: null,
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
    kept: true,
    accent: null,
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
    kept: true,
    accent: null,
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
    kept: true,
    accent: null,
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
    kept: true,
    accent: null,
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
    kept: true,
    accent: null,
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
  {
    id: "one",
    label: "One Dark / One Light",
    kept: false,
    accent: null,
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
    kept: false,
    accent: null,
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
    id: "ayu",
    label: "Ayu",
    kept: false,
    accent: null,
    light: palette([
      "#fcfcfc",
      "#f8f9fa",
      "#f0f1f2",
      "#e7e8e9",
      "#f3f4f5",
      "#e1e3e6",
      "#5c6166",
      "#8a9199",
      "#fa8d3e",
      "#fcfcfc",
      "#399ee6",
      "#e65050",
      "#fcfcfc",
    ]),
    dark: palette([
      "#0d1017",
      "#131721",
      "#1a1f29",
      "#222733",
      "#0b0e14",
      "#1b1f29",
      "#bfbdb6",
      "#6c7380",
      "#e6b450",
      "#0d1017",
      "#59c2ff",
      "#d95757",
      "#0d1017",
    ]),
  },
  {
    id: "monokai",
    label: "Monokai",
    kept: false,
    accent: null,
    light: palette([
      "#faf4f2",
      "#fdf9f8",
      "#f2ebe8",
      "#e6e0de",
      "#ede7e5",
      "#d3cdcc",
      "#29242a",
      "#706b6e",
      "#269d69",
      "#faf4f2",
      "#e16032",
      "#e14775",
      "#faf4f2",
    ]),
    dark: palette([
      "#272822",
      "#2e2f28",
      "#3e3d32",
      "#49483e",
      "#1e1f1c",
      "#49483e",
      "#f8f8f2",
      "#a59f85",
      "#a6e22e",
      "#272822",
      "#fd971f",
      "#f92672",
      "#272822",
    ]),
  },
  {
    id: "material",
    label: "Material",
    kept: false,
    accent: null,
    light: palette([
      "#fafafa",
      "#ffffff",
      "#eeeeee",
      "#e7eaec",
      "#f0f0f0",
      "#d3e1e8",
      "#37474f",
      "#7e939e",
      "#6182b8",
      "#fafafa",
      "#7c4dff",
      "#e53935",
      "#fafafa",
    ]),
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
    label: "Zenburn",
    kept: false,
    accent: null,
    light: palette([
      "#f2f1e6",
      "#f7f6ee",
      "#e8e7da",
      "#dedccd",
      "#e9e8dc",
      "#d6d4c4",
      "#3f3f3f",
      "#6f6f5f",
      "#5f7f5f",
      "#f2f1e6",
      "#9c6b4a",
      "#a85050",
      "#f2f1e6",
    ]),
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
    id: "warm-paper",
    label: "Warm Paper",
    kept: false,
    accent: null,
    light: palette([
      "#f5efe0",
      "#faf6ea",
      "#ece4d0",
      "#e4dac2",
      "#efe7d4",
      "#ddd2b8",
      "#3b3226",
      "#7a6c58",
      "#8a5a2b",
      "#faf6ea",
      "#b5652b",
      "#a8322a",
      "#faf6ea",
    ]),
    dark: palette([
      "#24201a",
      "#2b261f",
      "#352f26",
      "#3e372c",
      "#1f1b16",
      "#40382c",
      "#e8dfcc",
      "#a89a82",
      "#d7a86e",
      "#24201a",
      "#e08a4c",
      "#d4675a",
      "#24201a",
    ]),
  },
  {
    id: "night-owl",
    label: "Night Owl",
    kept: false,
    accent: null,
    light: palette([
      "#fbfbfb",
      "#ffffff",
      "#f0f0f0",
      "#e0e7ea",
      "#f0f0f0",
      "#d9d9d9",
      "#403f53",
      "#7b8191",
      "#4876d6",
      "#fbfbfb",
      "#994cc3",
      "#de3d3b",
      "#fbfbfb",
    ]),
    dark: palette([
      "#011627",
      "#0b2942",
      "#0b2942",
      "#1d3b53",
      "#01111d",
      "#122d42",
      "#d6deeb",
      "#7f9bb3",
      "#82aaff",
      "#011627",
      "#c792ea",
      "#ef5350",
      "#011627",
    ]),
  },
  {
    id: "ia-writer",
    label: "iA Writer Grey",
    kept: false,
    accent: null,
    light: palette([
      "#f7f7f7",
      "#fbfbfb",
      "#eeeeee",
      "#e6e6e6",
      "#f0f0f0",
      "#e0e0e0",
      "#2c2c2c",
      "#8a8a8a",
      "#2c2c2c",
      "#f7f7f7",
      "#19a0dc",
      "#d9534f",
      "#f7f7f7",
    ]),
    dark: palette([
      "#1a1a1a",
      "#202020",
      "#2a2a2a",
      "#333333",
      "#161616",
      "#333333",
      "#cccccc",
      "#808080",
      "#cccccc",
      "#1a1a1a",
      "#1ea9e6",
      "#e0605a",
      "#1a1a1a",
    ]),
  },
  {
    id: "graphite",
    label: "Graphite",
    kept: false,
    accent: null,
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
    id: "slate",
    label: "Slate",
    kept: false,
    accent: null,
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
      "#0f172a",
      "#1e293b",
      "#1e293b",
      "#334155",
      "#0b1220",
      "#334155",
      "#e2e8f0",
      "#94a3b8",
      "#e2e8f0",
      "#0f172a",
      "#2dd4bf",
      "#f87171",
      "#0f172a",
    ]),
  },
  {
    id: "warm-grey",
    label: "Warm Grey",
    kept: false,
    accent: null,
    light: palette([
      "#fafaf9",
      "#ffffff",
      "#f5f5f4",
      "#e7e5e4",
      "#f5f5f4",
      "#e7e5e4",
      "#1c1917",
      "#78716c",
      "#44403c",
      "#fafaf9",
      "#65a30d",
      "#dc2626",
      "#ffffff",
    ]),
    dark: palette([
      "#1c1917",
      "#292524",
      "#292524",
      "#44403c",
      "#171412",
      "#44403c",
      "#e7e5e4",
      "#a8a29e",
      "#e7e5e4",
      "#1c1917",
      "#84cc16",
      "#f87171",
      "#1c1917",
    ]),
  },
  {
    id: "scandi-grey",
    label: "Scandinavian Grey",
    kept: false,
    accent: null,
    light: palette([
      "#f7f7f7",
      "#fcfcfc",
      "#eeeeee",
      "#e5e5e5",
      "#f0f0f0",
      "#dddddd",
      "#222222",
      "#777777",
      "#333333",
      "#f7f7f7",
      "#555555",
      "#1a1a1a",
      "#f7f7f7",
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
    id: "pale-slate",
    label: "Pale Slate",
    kept: false,
    accent: null,
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
    id: "ascii-terminal",
    label: "ASCII Terminal",
    kept: false,
    accent: null,
    light: palette([
      "#f4f1e8",
      "#f8f6ef",
      "#ebe7da",
      "#e2ddcd",
      "#efebe0",
      "#8a8676",
      "#111111",
      "#555555",
      "#111111",
      "#f4f1e8",
      "#2a2a2a",
      "#9a1a1a",
      "#f4f1e8",
    ]),
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
  {
    id: "cyberpunk",
    label: "Cyberpunk",
    kept: false,
    accent: null,
    light: palette([
      "#f3f0ff",
      "#faf8ff",
      "#e8e3fb",
      "#ddd5f7",
      "#ece7fd",
      "#cfc4f2",
      "#1a1033",
      "#5d4f86",
      "#d1007f",
      "#ffffff",
      "#0090a8",
      "#a67c00",
      "#ffffff",
    ]),
    dark: palette([
      "#0a0a1a",
      "#10102a",
      "#16163a",
      "#1e1e4a",
      "#07071a",
      "#2a2a5a",
      "#e0e0ff",
      "#8a8ac0",
      "#ff2bd6",
      "#0a0a1a",
      "#00f0ff",
      "#fcee0a",
      "#0a0a1a",
    ]),
  },
  accentTheme("neon-pink", "Neon Pink", {
    light: [
      "#fdf8fb",
      "#ffffff",
      "#f6ecf2",
      "#f0e1ea",
      "#f9f1f6",
      "#eadbe4",
      "#2a2027",
      "#7a6872",
      "#c2347f",
      "#0e7490",
      "#c62839",
    ],
    dark: [
      "#141118",
      "#1a1620",
      "#231d2b",
      "#2c2436",
      "#110e15",
      "#2e2735",
      "#ece6f0",
      "#a69bb0",
      "#ff9bd2",
      "#8fdcff",
      "#ff6b7a",
    ],
  }),
  accentTheme("ember", "Ember", {
    light: [
      "#fcf9f5",
      "#ffffff",
      "#f5ede4",
      "#efe3d6",
      "#f8f2eb",
      "#e9dfd3",
      "#2b241d",
      "#7a6d60",
      "#c4540f",
      "#8a6400",
      "#c0392b",
    ],
    dark: [
      "#151311",
      "#1b1815",
      "#25201b",
      "#2e2721",
      "#110f0d",
      "#2f2924",
      "#eee7df",
      "#a89d90",
      "#ff9a4d",
      "#e9c46a",
      "#ff6b5b",
    ],
  }),
  accentTheme("lagoon", "Lagoon", {
    light: [
      "#f5fafa",
      "#ffffff",
      "#e8f2f1",
      "#dcebea",
      "#eef6f5",
      "#d6e5e3",
      "#18292a",
      "#5d7472",
      "#0f7a6e",
      "#b4532a",
      "#c0392b",
    ],
    dark: [
      "#0f1617",
      "#131c1d",
      "#1a2627",
      "#213031",
      "#0c1213",
      "#223234",
      "#dfeceb",
      "#8fa7a5",
      "#4fd6c4",
      "#f4a98a",
      "#ff7a6b",
    ],
  }),
  accentTheme("acid-lime", "Acid Lime", {
    light: [
      "#f8faf3",
      "#ffffff",
      "#eef2e4",
      "#e4ead6",
      "#f2f5ea",
      "#dde4cf",
      "#1f251a",
      "#687258",
      "#4f7d0c",
      "#1f6fb2",
      "#c0392b",
    ],
    dark: [
      "#121410",
      "#171a14",
      "#1f231b",
      "#282d22",
      "#0e100c",
      "#2a2f24",
      "#e8eddf",
      "#9ea692",
      "#bff25a",
      "#8cc8ff",
      "#ff6b6b",
    ],
  }),
  accentTheme("ultraviolet", "Ultraviolet", {
    light: [
      "#f9f7fd",
      "#ffffff",
      "#efeaf9",
      "#e6dff6",
      "#f3f0fa",
      "#e0d9ef",
      "#221d33",
      "#6e6789",
      "#6a3fd4",
      "#9a5b00",
      "#c62839",
    ],
    dark: [
      "#13111b",
      "#181523",
      "#211c30",
      "#2a243c",
      "#0f0d16",
      "#2c2640",
      "#e9e5f5",
      "#a29bb8",
      "#b8a1ff",
      "#ffd27a",
      "#ff6b8a",
    ],
  }),
  accentTheme("amber", "Amber", {
    light: [
      "#fcf9f0",
      "#ffffff",
      "#f5efdd",
      "#eee5cc",
      "#f8f3e5",
      "#e8dfc5",
      "#2a2414",
      "#786d50",
      "#9a6700",
      "#b5452a",
      "#b3261e",
    ],
    dark: [
      "#13110c",
      "#191610",
      "#221e15",
      "#2b261b",
      "#0f0d09",
      "#2e291d",
      "#f0e9d8",
      "#a99f86",
      "#ffc247",
      "#ff8f6b",
      "#ff6b5b",
    ],
  }),
  accentTheme("crimson", "Crimson", {
    light: [
      "#fcf7f7",
      "#ffffff",
      "#f6eaeb",
      "#f0dfe0",
      "#f9f0f1",
      "#ecd9db",
      "#2b1d20",
      "#7d6467",
      "#c01c30",
      "#8a5a1b",
      "#a8321b",
    ],
    dark: [
      "#151012",
      "#1b1517",
      "#251c1f",
      "#2f2428",
      "#110d0e",
      "#33262a",
      "#f0e4e6",
      "#ad979b",
      "#ff5f6d",
      "#f2c38f",
      "#ff7b5c",
    ],
  }),
  accentTheme("glacier", "Glacier", {
    light: [
      "#f4f9fc",
      "#ffffff",
      "#e7f0f6",
      "#dae8f1",
      "#edf4f9",
      "#d4e3ec",
      "#172532",
      "#5b6f80",
      "#0369a1",
      "#b0306f",
      "#c62839",
    ],
    dark: [
      "#0e1319",
      "#121921",
      "#19222d",
      "#202b38",
      "#0b0f14",
      "#22303d",
      "#e0eaf2",
      "#8fa1b2",
      "#66e3ff",
      "#ffa3d1",
      "#ff6b7a",
    ],
  }),
  accentTheme("mint", "Mint", {
    light: [
      "#f7f9f8",
      "#ffffff",
      "#edf2ef",
      "#e2e9e5",
      "#f1f5f3",
      "#dce4e0",
      "#1b2420",
      "#64726b",
      "#0f7a4c",
      "#6b4fc8",
      "#c0392b",
    ],
    dark: [
      "#161818",
      "#1b1e1e",
      "#232727",
      "#2b3030",
      "#121414",
      "#2c3131",
      "#e4ebe8",
      "#97a39e",
      "#7ef0b4",
      "#c9b5ff",
      "#ff6b6b",
    ],
  }),
  accentTheme("cobalt", "Cobalt", {
    light: [
      "#f6f8fd",
      "#ffffff",
      "#eaeef9",
      "#dfe5f5",
      "#eff2fa",
      "#d9dfef",
      "#1a2035",
      "#646c88",
      "#2453c9",
      "#a3530b",
      "#c62839",
    ],
    dark: [
      "#10121a",
      "#141722",
      "#1b1f2d",
      "#232838",
      "#0c0e14",
      "#252a3b",
      "#e3e7f3",
      "#959cb5",
      "#7aa7ff",
      "#ffb86b",
      "#ff6b7a",
    ],
  }),
]

export function normalizeAppThemeId(themeId: string | null): string {
  return APP_THEMES.some(({ id }) => id === themeId)
    ? (themeId ?? DEFAULT_APP_THEME_ID)
    : DEFAULT_APP_THEME_ID
}

/** The themes a release channel offers in Settings: all on Alpha, only kept ones elsewhere. */
export function appThemesForChannel(channel: AppChannel): readonly AppTheme[] {
  return channel === "alpha" ? APP_THEMES : APP_THEMES.filter((theme) => theme.kept)
}

/** The saved theme when the channel offers it; otherwise Default. */
export function availableAppThemeId(themeId: string, channel: AppChannel): string {
  return appThemesForChannel(channel).some(({ id }) => id === themeId)
    ? themeId
    : DEFAULT_APP_THEME_ID
}

export function resolveAppThemeTokens(
  themeId: string,
  mode: ResolvedThemeMode,
): ThemeTokenSet | null {
  const normalizedId = normalizeAppThemeId(themeId)
  if (normalizedId === DEFAULT_APP_THEME_ID) return null
  const theme = APP_THEMES.find(({ id }) => id === normalizedId)
  if (!theme) return null
  const base = buildTokenSet(theme[mode])
  return theme.accent ? { ...base, ...accentTokens(theme[mode], theme.accent[mode].accent) } : base
}

/** Code editor colors of an accent theme; null for other themes, which keep the editor theme. */
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
): AccentEditorColors | null {
  const theme = APP_THEMES.find(({ id }) => id === themeId)
  if (!theme?.accent) return null
  const colors = theme[mode]
  const { accent, secondary } = theme.accent[mode]
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

/**
 * The accent-colored tokens: card borders use the accent as given; text uses it
 * as far as it stays readable on the surfaces it sits on.
 */
function accentTokens(colors: Palette, accent: string): Record<AccentThemeToken, string> {
  const text = accentText(colors, accent)
  const selected = blend(colors.sidebar, accent, 0.16)
  return {
    "panel-border": accent,
    "panel-title": text,
    heading: text,
    selected,
    "selected-foreground": readableOn([selected, colors.background, colors.surface], accent),
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
