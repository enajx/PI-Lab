import { join, resolve } from "node:path"

export interface AppIconPathContext {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}

export interface AppIconFileSystem {
  exists: (path: string) => boolean
}

export interface DockIconAdapter {
  setIcon: (path: string) => void
}

export interface AppIdentityLogger {
  warn: (message: string) => void
}

export type DockIconOutcome = "applied" | "failed" | "skipped"

/**
 * Resolve the one canonical Pi tile for main-process surfaces.
 *
 * Development reads the repository master directly. Packaging copies the same
 * generated PNG into Resources so runtime identity never depends on source-tree
 * paths, the source font, or outline-extraction tooling.
 */
export function resolveAppIconPath(
  context: AppIconPathContext,
  fileSystem: AppIconFileSystem,
): string | null {
  const candidate = context.isPackaged
    ? join(context.resourcesPath, "pi-lab-icon.png")
    : resolve(context.appPath, "..", "..", "icons", "icon.png")
  return fileSystem.exists(candidate) ? candidate : null
}

/**
 * Apply the explicit development Dock identity on macOS. Packaged identity is
 * still owned by electron-builder's generated application bundle icon.
 */
export function applyMacDockIcon(
  iconPath: string | null,
  platform: NodeJS.Platform,
  dock: DockIconAdapter | null,
  logger: AppIdentityLogger,
): DockIconOutcome {
  if (platform !== "darwin" || !iconPath || !dock) return "skipped"

  try {
    dock.setIcon(iconPath)
    return "applied"
  } catch (error) {
    logger.warn(
      `[pi-lab] Dock icon unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
    return "failed"
  }
}
