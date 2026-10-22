import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  APP_ICON_DEFAULT_SELECTION,
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

/** Alpha generates palettes and range changes from the selected shape master. */
export function alphaIconNeedsRecolor(selection: AppIconSelection): boolean {
  const palette = selection.family === "joyplot" ? selection.joyplotPalette : selection.piPalette
  const reversed = selection.family === "joyplot" ? selection.joyplotReverse : selection.piReverse
  const limited =
    selection.family === "joyplot"
      ? selection.joyplotLimitVisibleRange
      : selection.piLimitVisibleRange
  return palette !== "viridis" || reversed || limited
}

function defaultSelection(channel: PiLabChannel): AppIconSelection {
  return channel === "alpha"
    ? {
        ...APP_ICON_DEFAULT_SELECTION,
        alphaWhiteBackground: true,
        joyplotPalette: "viridis",
        piPalette: "viridis",
      }
    : { ...APP_ICON_DEFAULT_SELECTION }
}

/** Read the saved selection so main can apply it before the first window opens. */
export function loadAppIconSelection(
  userDataPath: string,
  logger: AppIdentityLogger,
  channel: PiLabChannel,
): AppIconSelection {
  if (channel !== "alpha") return defaultSelection(channel)
  const path = join(userDataPath, SELECTION_FILE)
  if (!existsSync(path)) return defaultSelection(channel)
  const contents = readFileSync(path, "utf8")
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    logger.warn(`[pi-lab] Invalid app icon selection in ${path}; using default`)
    return defaultSelection(channel)
  }
  if (typeof value === "object" && value !== null) {
    const saved = value as Record<string, unknown>
    const current = { ...saved }
    delete current.favoritePalettes
    value = {
      ...current,
      alphaWhiteBackground:
        saved.alphaWhiteBackground === undefined ? false : saved.alphaWhiteBackground,
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
    return defaultSelection(channel)
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

/** Resolve a packaged or development PNG for the active family and color theme. */
export function resolveSelectedAppIconPath(
  selection: AppIconSelection,
  context: AppIconPathContext,
  fileSystem: AppIconFileSystem,
): string {
  const channel = context.channel ?? "stable"
  const assetChannel = channel === "alpha" && selection.alphaWhiteBackground ? "stable" : channel
  const selectedPalette =
    selection.family === "joyplot" ? selection.joyplotPalette : selection.piPalette
  const assetPalette = channel === "alpha" ? "viridis" : selectedPalette
  const isCanonical =
    (channel === "stable" &&
      selection.family === "pi" &&
      selection.piFont === "gill-sans-regular" &&
      selection.piPalette === "gray-30" &&
      !selection.piReverse &&
      !selection.piLimitVisibleRange) ||
    (channel === "alpha" &&
      selection.alphaWhiteBackground &&
      selection.family === "pi" &&
      selection.piFont === "gill-sans-regular" &&
      selection.piPalette === "viridis" &&
      !selection.piReverse &&
      !selection.piLimitVisibleRange) ||
    (channel === "beta" &&
      selection.family === "pi" &&
      selection.piFont === "gill-sans-regular" &&
      selection.piPalette === "gray-30" &&
      !selection.piReverse &&
      !selection.piLimitVisibleRange)
  const name =
    selection.family === "joyplot"
      ? `joyplot-${selection.joyplotStyle}-${assetChannel === "stable" ? assetPalette : assetChannel}${channel !== "alpha" && selection.joyplotReverse ? "-reversed" : ""}${channel !== "alpha" && selection.joyplotLimitVisibleRange ? "-limited" : ""}${selection.joyplotExpanded ? "-expanded" : ""}.png`
      : `pi-${selection.piFont}-${assetChannel === "stable" ? assetPalette : assetChannel}${channel !== "alpha" && selection.piReverse ? "-reversed" : ""}${channel !== "alpha" && selection.piLimitVisibleRange ? "-limited" : ""}.png`
  const path = isCanonical
    ? resolveAppIconPath(context, fileSystem)
    : context.isPackaged
      ? join(
          context.resourcesPath,
          assetChannel === "stable" ? "app-icon-variants" : "app-icon-channel-variants",
          name,
        )
      : resolve(context.appPath, assetChannel === "stable" ? RENDERER_ICONS : CHANNEL_ICONS, name)
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
    const fallback = defaultSelection(context.channel ?? "stable")
    return {
      selection: fallback,
      path: resolveSelectedAppIconPath(fallback, context, fileSystem),
    }
  }
}
