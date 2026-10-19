import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { app } from "electron"
import { channelFromAppName, channelIdentity, type PiLabChannel } from "../identity/channel"

const BACKGROUND_ARG = "--pi-lab-background"

export interface StartAtLoginState {
  enabled: boolean
  available: boolean
}

interface NativeLoginPort {
  getLoginItemSettings: (options?: { path?: string; args?: string[] }) => { openAtLogin: boolean }
  setLoginItemSettings: (settings: { openAtLogin: boolean; path?: string; args?: string[] }) => void
}

interface StartAtLoginOptions {
  platform: NodeJS.Platform
  isPackaged: boolean
  executable: string
  channel: PiLabChannel
  configHome: string
  native: NativeLoginPort | null
}

export interface StartAtLoginService {
  get: () => Promise<StartAtLoginState>
  set: (enabled: boolean) => Promise<StartAtLoginState>
}

/** Quote one executable path for a freedesktop Exec field. */
function desktopExecutable(path: string): string {
  if (path.includes("\n") || path.includes("\r")) throw new Error("Invalid executable path")
  const escaped = path
    .replaceAll("\\", "\\\\\\\\")
    .replaceAll('"', '\\\\"')
    .replaceAll("`", "\\\\`")
    .replaceAll("$", "\\\\$")
    .replaceAll("%", "%%")
  return `"${escaped}"`
}

/** Read or change the user's OS login item without copying the preference into SQLite. */
export function createStartAtLoginService(options: StartAtLoginOptions): StartAtLoginService {
  const available =
    options.isPackaged &&
    (options.platform === "linux" ||
      ((options.platform === "darwin" || options.platform === "win32") && options.native !== null))
  const identity = channelIdentity(options.channel)
  const entryPath = join(options.configHome, "autostart", identity.autostartName)
  const loginOptions =
    options.platform === "win32" ? { path: options.executable, args: [BACKGROUND_ARG] } : undefined

  const get = async (): Promise<StartAtLoginState> => {
    if (!available) return { enabled: false, available: false }
    if (options.platform === "linux") {
      if (!existsSync(entryPath)) return { enabled: false, available: true }
      const content = await readFile(entryPath, "utf8")
      return { enabled: !/^Hidden=true$/mu.test(content), available: true }
    }
    if (!options.native) throw new Error("OS login service is unavailable")
    return {
      enabled: options.native.getLoginItemSettings(loginOptions).openAtLogin,
      available: true,
    }
  }

  const set = async (enabled: boolean): Promise<StartAtLoginState> => {
    if (!available) throw new Error("Start at login requires a packaged desktop app")
    if (options.platform === "linux") {
      if (enabled) {
        await mkdir(join(options.configHome, "autostart"), { recursive: true })
        await writeFile(
          entryPath,
          `[Desktop Entry]\nType=Application\nName=${identity.name}\nExec=${desktopExecutable(options.executable)} ${BACKGROUND_ARG}\nTerminal=false\n`,
          "utf8",
        )
      } else {
        await rm(entryPath, { force: true })
      }
      return get()
    }
    if (!options.native) throw new Error("OS login service is unavailable")
    options.native.setLoginItemSettings({ openAtLogin: enabled, ...loginOptions })
    return get()
  }
  return { get, set }
}

/** Select stable packaged paths for the current host. */
export function liveStartAtLoginService(): StartAtLoginService {
  const xdgConfig = process.env.XDG_CONFIG_HOME
  const configHome = xdgConfig && isAbsolute(xdgConfig) ? xdgConfig : join(homedir(), ".config")
  const appImage = process.env.APPIMAGE
  const executable = appImage && isAbsolute(appImage) ? appImage : app.getPath("exe")
  return createStartAtLoginService({
    platform: process.platform,
    isPackaged: app.isPackaged,
    executable,
    channel: channelFromAppName(app.getName()),
    configHome,
    native: process.platform === "linux" ? null : app,
  })
}
