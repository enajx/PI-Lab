export interface MenuBarIconService {
  get(): { visible: boolean; available: boolean }
  set(visible: boolean): { visible: boolean; available: boolean }
}

/** Preserve the older settings API while the macOS icon is always visible. */
export function createMenuBarIconService(platform: NodeJS.Platform): MenuBarIconService {
  const state = () => ({ visible: platform === "darwin", available: false })
  return {
    get: state,
    set: (visible) => {
      if (platform !== "darwin") throw new Error("Menu-bar icon requires macOS")
      if (!visible) throw new Error("The menu-bar icon is always visible while PI Lab is running")
      return state()
    },
  }
}
