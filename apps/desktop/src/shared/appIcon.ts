/** The icon choices shared by Settings, preload, and the main process. */
import iconSolidColors from "./iconSolidColors.json"

export const APP_ICON_SOLID_COLORS = iconSolidColors
export const APP_ICON_GET_CHANNEL = "app-icon:get"
export const APP_ICON_SET_CHANNEL = "app-icon:set"
export const APP_ICON_PREVIEW_CHANNEL = "app-icon:preview"
export const APP_ICON_IDENTITY_CHANNEL = "app-icon:identity"

export const APP_ICON_JOYPLOT_STYLES = [
  "25",
  "26",
  "27",
  "28",
  "29",
  "30",
  "31",
  "32",
  "33",
  "34",
  "35",
  "36",
  "37",
  "38",
  "39",
  "40",
  "41",
  "42",
  "43",
  "44",
  "45",
  "46",
  "47",
  "48",
  "49",
  "50",
  "51",
  "52",
] as const

/** Continuous Matplotlib 3.11.2 colormaps, plus PI Lab's Magma + Iris blend. */
export const APP_ICON_PALETTES = [
  "magma",
  "magma-iris",
  "viridis",
  "plasma",
  "inferno",
  "cividis",
  "black",
  "gray-10",
  "gray-20",
  "gray-30",
  "gray-40",
  "gray-50",
  "Greys",
  "Purples",
  "Blues",
  "Greens",
  "Oranges",
  "Reds",
  "YlOrBr",
  "YlOrRd",
  "OrRd",
  "PuRd",
  "RdPu",
  "BuPu",
  "GnBu",
  "PuBu",
  "YlGnBu",
  "PuBuGn",
  "BuGn",
  "YlGn",
  "gray",
  "bone",
  "pink",
  "spring",
  "summer",
  "autumn",
  "winter",
  "cool",
  "Wistia",
  "hot",
  "afmhot",
  "gist_heat",
  "copper",
  "PiYG",
  "PRGn",
  "BrBG",
  "PuOr",
  "RdGy",
  "RdBu",
  "RdYlBu",
  "RdYlGn",
  "Spectral",
  "coolwarm",
  "bwr",
  "seismic",
  "berlin",
  "managua",
  "vanimo",
  "twilight",
  "twilight_shifted",
  "hsv",
  "ocean",
  "gist_earth",
  "terrain",
  "gist_stern",
  "gnuplot",
  "gnuplot2",
  "CMRmap",
  "cubehelix",
  "brg",
  "gist_rainbow",
  "rainbow",
  "jet",
  "turbo",
  "nipy_spectral",
  "gist_ncar",
] as const

export const APP_ICON_PI_FONTS = [
  "baskerville-regular",
  "didot-bold",
  "times-new-roman-regular",
  "georgia-regular",
  "palatino-regular",
  "stix-two-text-regular",
  "avenir-next-medium",
  "futura-medium",
  "helvetica-neue-medium",
  "gill-sans-regular",
  "rockwell-regular",
  "copperplate-regular",
] as const

export type AppIconFamily = "joyplot" | "pi"
export type JoyplotStyleId = (typeof APP_ICON_JOYPLOT_STYLES)[number]
export type AppIconPalette = (typeof APP_ICON_PALETTES)[number]
export type PiIconFontId = (typeof APP_ICON_PI_FONTS)[number]

export interface JoyplotAppIconFavorite {
  family: "joyplot"
  alphaWhiteBackground?: boolean
  style: JoyplotStyleId
  palette: AppIconPalette
  expanded: boolean
  reverse: boolean
  limitVisibleRange: boolean
}

export interface PiAppIconFavorite {
  family: "pi"
  alphaWhiteBackground?: boolean
  font: PiIconFontId
  palette: AppIconPalette
  reverse: boolean
  limitVisibleRange: boolean
}

export type AppIconFavorite = JoyplotAppIconFavorite | PiAppIconFavorite

export interface AppIconSelection {
  family: AppIconFamily
  alphaWhiteBackground: boolean
  joyplotStyle: JoyplotStyleId
  joyplotPalette: AppIconPalette
  joyplotExpanded: boolean
  joyplotReverse: boolean
  joyplotLimitVisibleRange: boolean
  piFont: PiIconFontId
  piPalette: AppIconPalette
  piReverse: boolean
  piLimitVisibleRange: boolean
  favoriteIcons: AppIconFavorite[]
}

export interface AppIconBridge {
  getChannel(): Promise<"alpha" | "beta" | "stable">
  get(): Promise<AppIconSelection>
  set(selection: AppIconSelection): Promise<AppIconSelection>
  preview(selection: AppIconSelection): Promise<string>
}

export const APP_ICON_DEFAULT_SELECTION: AppIconSelection = {
  family: "pi",
  alphaWhiteBackground: false,
  joyplotStyle: "25",
  joyplotPalette: "magma",
  joyplotExpanded: true,
  joyplotReverse: false,
  joyplotLimitVisibleRange: false,
  piFont: "gill-sans-regular",
  piPalette: "gray-30",
  piReverse: false,
  piLimitVisibleRange: false,
  favoriteIcons: [],
}

/** Copy only the settings that determine the active family's icon artwork. */
export function snapshotAppIconFavorite(selection: AppIconSelection): AppIconFavorite {
  return selection.family === "joyplot"
    ? {
        family: "joyplot",
        ...(selection.alphaWhiteBackground ? { alphaWhiteBackground: true } : {}),
        style: selection.joyplotStyle,
        palette: selection.joyplotPalette,
        expanded: selection.joyplotExpanded,
        reverse: selection.joyplotReverse,
        limitVisibleRange: selection.joyplotLimitVisibleRange,
      }
    : {
        family: "pi",
        ...(selection.alphaWhiteBackground ? { alphaWhiteBackground: true } : {}),
        font: selection.piFont,
        palette: selection.piPalette,
        reverse: selection.piReverse,
        limitVisibleRange: selection.piLimitVisibleRange,
      }
}

/** Check whether the current icon matches every setting in a saved favorite. */
export function matchesAppIconFavorite(
  selection: AppIconSelection,
  favorite: AppIconFavorite,
): boolean {
  if (selection.family !== favorite.family) return false
  return favoriteIdentity(snapshotAppIconFavorite(selection)) === favoriteIdentity(favorite)
}

/** Restore one favorite while retaining the other family's saved choices. */
export function applyAppIconFavorite(
  selection: AppIconSelection,
  favorite: AppIconFavorite,
): AppIconSelection {
  return favorite.family === "joyplot"
    ? {
        ...selection,
        family: "joyplot",
        alphaWhiteBackground: favorite.alphaWhiteBackground === true,
        joyplotStyle: favorite.style,
        joyplotPalette: favorite.palette,
        joyplotExpanded: favorite.expanded,
        joyplotReverse: favorite.reverse,
        joyplotLimitVisibleRange: favorite.limitVisibleRange,
      }
    : {
        ...selection,
        family: "pi",
        alphaWhiteBackground: favorite.alphaWhiteBackground === true,
        piFont: favorite.font,
        piPalette: favorite.palette,
        piReverse: favorite.reverse,
        piLimitVisibleRange: favorite.limitVisibleRange,
      }
}

/** Reject incomplete favorites and settings from the wrong icon family. */
export function isAppIconFavorite(value: unknown): value is AppIconFavorite {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  if (candidate.family === "joyplot") {
    return (
      hasFavoriteKeys(candidate, [
        "family",
        "style",
        "palette",
        "expanded",
        "reverse",
        "limitVisibleRange",
      ]) &&
      APP_ICON_JOYPLOT_STYLES.some((id) => id === candidate.style) &&
      APP_ICON_PALETTES.some((id) => id === candidate.palette) &&
      typeof candidate.expanded === "boolean" &&
      typeof candidate.reverse === "boolean" &&
      typeof candidate.limitVisibleRange === "boolean"
    )
  }
  if (candidate.family === "pi") {
    return (
      hasFavoriteKeys(candidate, ["family", "font", "palette", "reverse", "limitVisibleRange"]) &&
      APP_ICON_PI_FONTS.some((id) => id === candidate.font) &&
      APP_ICON_PALETTES.some((id) => id === candidate.palette) &&
      typeof candidate.reverse === "boolean" &&
      typeof candidate.limitVisibleRange === "boolean"
    )
  }
  return false
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value)
}

function hasFavoriteKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    hasExactKeys(value, keys) ||
    (hasExactKeys(value, [...keys, "alphaWhiteBackground"]) &&
      typeof value.alphaWhiteBackground === "boolean")
  )
}

function favoriteIdentity(favorite: AppIconFavorite): string {
  return favorite.family === "joyplot"
    ? JSON.stringify([
        favorite.family,
        favorite.style,
        favorite.palette,
        favorite.expanded,
        favorite.reverse,
        favorite.limitVisibleRange,
        favorite.alphaWhiteBackground === true,
      ])
    : JSON.stringify([
        favorite.family,
        favorite.font,
        favorite.palette,
        favorite.reverse,
        favorite.limitVisibleRange,
        favorite.alphaWhiteBackground === true,
      ])
}

/** Validate persisted and IPC input before using it to choose an asset. */
export function isAppIconSelection(value: unknown): value is AppIconSelection {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    (candidate.family === "joyplot" || candidate.family === "pi") &&
    typeof candidate.alphaWhiteBackground === "boolean" &&
    APP_ICON_JOYPLOT_STYLES.some((id) => id === candidate.joyplotStyle) &&
    APP_ICON_PALETTES.some((id) => id === candidate.joyplotPalette) &&
    typeof candidate.joyplotExpanded === "boolean" &&
    typeof candidate.joyplotReverse === "boolean" &&
    typeof candidate.joyplotLimitVisibleRange === "boolean" &&
    APP_ICON_PI_FONTS.some((id) => id === candidate.piFont) &&
    APP_ICON_PALETTES.some((id) => id === candidate.piPalette) &&
    typeof candidate.piReverse === "boolean" &&
    typeof candidate.piLimitVisibleRange === "boolean" &&
    Array.isArray(candidate.favoriteIcons) &&
    candidate.favoriteIcons.every(isAppIconFavorite) &&
    new Set(candidate.favoriteIcons.map(favoriteIdentity)).size === candidate.favoriteIcons.length
  )
}
