import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface MenuBarIconService {
  get(): { visible: boolean; available: boolean }
  set(visible: boolean): { visible: boolean; available: boolean }
}

/** Persist whether macOS shows the background menu-bar icon. */
export function createMenuBarIconService(
  userDataPath: () => string,
  platform: NodeJS.Platform,
): MenuBarIconService {
  const markerPath = () => join(userDataPath(), "menu-bar-icon-hidden")
  return {
    get: () => ({
      visible: platform === "darwin" ? !existsSync(markerPath()) : false,
      available: platform === "darwin",
    }),
    set: (visible) => {
      if (platform !== "darwin") throw new Error("Menu-bar icon setting requires macOS")
      const path = markerPath()
      if (visible) rmSync(path, { force: true })
      else {
        mkdirSync(userDataPath(), { recursive: true })
        writeFileSync(path, "")
      }
      return { visible, available: true }
    },
  }
}
