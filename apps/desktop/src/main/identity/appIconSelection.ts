import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  APP_ICON_DEFAULT_SELECTION,
  type AppIconFavorite,
  type AppIconSelection,
  isAppIconSelection,
} from "../../shared/appIcon"
import {
  type AppIconFileSystem,
  type AppIconPathContext,
  type AppIdentityLogger,
  resolveAppIconPath,
} from "./appIcon"
import type { PiLabChannel } from "./channel"

const SELECTION_FILE = "app-icon-selection.json"
const RENDERER_ICONS = "src/renderer/routes/_shell/settings/components/AppIconGallery/icons"
const CHANNEL_ICONS = "src/renderer/routes/_shell/settings/components/AppIconGallery/channel-icons"
const RETIRED_JOYPLOT_STYLES = new Set(["06", "07", "13", "14", "16", "19", "20", "21", "22", "23"])

/** Read the saved selection so main can apply it before the first window opens. */
export function loadAppIconSelection(
  userDataPath: string,
  logger: AppIdentityLogger,
): AppIconSelection {
  const path = join(userDataPath, SELECTION_FILE)
  if (!existsSync(path)) return { ...APP_ICON_DEFAULT_SELECTION }
  const contents = readFileSync(path, "utf8")
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    logger.warn(`[pi-lab] Invalid app icon selection in ${path}; using default`)
    return { ...APP_ICON_DEFAULT_SELECTION }
  }
  if (typeof value === "object" && value !== null) {
    const saved = value as Record<string, unknown>
    const current = { ...saved }
    delete current.favoritePalettes
    value = {
      ...current,
      joyplotExpanded: saved.joyplotExpanded === undefined ? false : saved.joyplotExpanded,
      joyplotReverse: saved.joyplotReverse === undefined ? false : saved.joyplotReverse,
      joyplotLimitVisibleRange:
        saved.joyplotLimitVisibleRange === undefined ? false : saved.joyplotLimitVisibleRange,
      piReverse: saved.piReverse === undefined ? false : saved.piReverse,
      piLimitVisibleRange:
        saved.piLimitVisibleRange === undefined ? false : saved.piLimitVisibleRange,
      favoriteIcons: saved.favoriteIcons === undefined ? [] : saved.favoriteIcons,
    }
  }
  if (typeof value === "object" && value !== null) {
    const saved = value as Record<string, unknown>
    if (RETIRED_JOYPLOT_STYLES.has(String(saved.joyplotStyle))) {
      const migrated = {
        ...saved,
        joyplotStyle: APP_ICON_DEFAULT_SELECTION.joyplotStyle,
        joyplotPalette: APP_ICON_DEFAULT_SELECTION.joyplotPalette,
        joyplotExpanded: APP_ICON_DEFAULT_SELECTION.joyplotExpanded,
      }
      if (isAppIconSelection(migrated)) {
        logger.warn(`[pi-lab] Retired app icon selection in ${path}; keeping other choices`)
        saveAppIconSelection(userDataPath, migrated)
        return migrated
      }
    }
  }
  if (!isAppIconSelection(value)) {
    logger.warn(`[pi-lab] Invalid app icon selection in ${path}; using default`)
    return { ...APP_ICON_DEFAULT_SELECTION }
  }
  return value
}

/** Save the full choice atomically, including the inactive family's options. */
export function saveAppIconSelection(userDataPath: string, selection: AppIconSelection): void {
  const path = join(userDataPath, SELECTION_FILE)
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(selection, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

/** Keep Alpha's test icon color fixed; public Beta shares the Stable choice. */
export function normalizeAppIconSelectionForChannel(
  selection: AppIconSelection,
  channel: PiLabChannel,
): AppIconSelection {
  if (channel !== "alpha") return selection
  const palette = "viridis"
  const seen = new Set<string>()
  const favoriteIcons: AppIconFavorite[] = []
  for (const favorite of selection.favoriteIcons) {
    const normalized = { ...favorite, palette } as AppIconFavorite
    const identity = JSON.stringify(normalized)
    if (seen.has(identity)) continue
    seen.add(identity)
    favoriteIcons.push(normalized)
  }
  return { ...selection, joyplotPalette: palette, piPalette: palette, favoriteIcons }
}

/** Resolve a packaged or development PNG for the active family and color theme. */
export function resolveSelectedAppIconPath(
  selection: AppIconSelection,
  context: AppIconPathContext,
  fileSystem: AppIconFileSystem,
): string {
  const channel = context.channel ?? "stable"
  const isCanonical =
    selection.family === "joyplot" &&
    selection.joyplotStyle === "25" &&
    channel !== "beta" &&
    (channel === "alpha" || selection.joyplotPalette === "magma") &&
    selection.joyplotExpanded &&
    !selection.joyplotReverse &&
    !selection.joyplotLimitVisibleRange
  const name =
    selection.family === "joyplot"
      ? `joyplot-${selection.joyplotStyle}-${channel === "stable" ? selection.joyplotPalette : channel}${selection.joyplotReverse ? "-reversed" : ""}${selection.joyplotLimitVisibleRange ? "-limited" : ""}${selection.joyplotExpanded ? "-expanded" : ""}.png`
      : `pi-${selection.piFont}-${channel === "stable" ? selection.piPalette : channel}${selection.piReverse ? "-reversed" : ""}${selection.piLimitVisibleRange ? "-limited" : ""}.png`
  const path = isCanonical
    ? resolveAppIconPath(context, fileSystem)
    : context.isPackaged
      ? join(
          context.resourcesPath,
          channel === "stable" ? "app-icon-variants" : "app-icon-channel-variants",
          name,
        )
      : resolve(context.appPath, channel === "stable" ? RENDERER_ICONS : CHANNEL_ICONS, name)
  if (!path || !fileSystem.exists(path)) {
    throw new Error(`selected app icon is missing: ${name}`)
  }
  return path
}

/** Keep startup usable if an older saved choice no longer has a packaged PNG. */
export function resolveStartupAppIcon(
  selection: AppIconSelection,
  context: AppIconPathContext,
  fileSystem: AppIconFileSystem,
  logger: AppIdentityLogger,
): { selection: AppIconSelection; path: string } {
  try {
    return { selection, path: resolveSelectedAppIconPath(selection, context, fileSystem) }
  } catch (error) {
    logger.warn(
      `[pi-lab] Saved app icon unavailable; using default: ${error instanceof Error ? error.message : String(error)}`,
    )
    const fallback = normalizeAppIconSelectionForChannel(
      { ...APP_ICON_DEFAULT_SELECTION },
      context.channel ?? "stable",
    )
    return {
      selection: fallback,
      path: resolveSelectedAppIconPath(fallback, context, fileSystem),
    }
  }
}
