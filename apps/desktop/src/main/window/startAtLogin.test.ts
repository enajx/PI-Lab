import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createStartAtLoginService } from "./startAtLogin"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.length = 0
})

describe("Start at login", () => {
  test("macOS reads and updates the OS login item independently of window-close behavior", async () => {
    let enabled = false
    const setLoginItemSettings = vi.fn((value: { openAtLogin?: boolean }) => {
      enabled = value.openAtLogin === true
    })
    const service = createStartAtLoginService({
      platform: "darwin",
      isPackaged: true,
      executable: "/Applications/PI Lab.app/Contents/MacOS/PI Lab",
      channel: "stable",
      configHome: "/unused",
      native: {
        getLoginItemSettings: () => ({ openAtLogin: enabled }),
        setLoginItemSettings,
      },
    })
    expect(await service.get()).toEqual({ enabled: false, available: true })
    expect(await service.set(true)).toEqual({ enabled: true, available: true })
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
  })

  test("Windows registers the background startup argument", async () => {
    const setLoginItemSettings = vi.fn()
    const getLoginItemSettings = vi.fn(() => ({ openAtLogin: true }))
    const service = createStartAtLoginService({
      platform: "win32",
      isPackaged: true,
      executable: "C:\\Program Files\\PI Lab\\PI Lab.exe",
      channel: "stable",
      configHome: "C:\\unused",
      native: { getLoginItemSettings, setLoginItemSettings },
    })
    expect(await service.get()).toEqual({ enabled: true, available: true })
    expect(getLoginItemSettings).toHaveBeenCalledWith({
      path: "C:\\Program Files\\PI Lab\\PI Lab.exe",
      args: ["--pi-lab-background"],
    })
    await service.set(false)
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
      path: "C:\\Program Files\\PI Lab\\PI Lab.exe",
      args: ["--pi-lab-background"],
    })
  })

  test("Linux writes a user XDG autostart entry and removes it when disabled", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "pi-lab-autostart-"))
    dirs.push(configHome)
    const service = createStartAtLoginService({
      platform: "linux",
      isPackaged: true,
      executable: "/home/user/PI Lab.AppImage",
      channel: "stable",
      configHome,
      native: null,
    })
    expect(await service.get()).toEqual({ enabled: false, available: true })
    expect(await service.set(true)).toEqual({ enabled: true, available: true })
    const entry = await readFile(join(configHome, "autostart", "com.pi-lab.desktop"), "utf8")
    expect(entry).toContain("[Desktop Entry]")
    expect(entry).toContain('Exec="/home/user/PI Lab.AppImage" --pi-lab-background')
    expect(await service.set(false)).toEqual({ enabled: false, available: true })
    expect(await service.get()).toEqual({ enabled: false, available: true })
  })

  test("development builds cannot register a login item", async () => {
    const service = createStartAtLoginService({
      platform: "darwin",
      isPackaged: false,
      executable: "/path/to/Electron",
      channel: "stable",
      configHome: "/unused",
      native: {
        getLoginItemSettings: () => ({ openAtLogin: false }),
        setLoginItemSettings: vi.fn(),
      },
    })
    expect(await service.get()).toEqual({ enabled: false, available: false })
    await expect(service.set(true)).rejects.toThrow("packaged")
  })

  test.each([
    "alpha",
    "beta",
  ] as const)("Linux %s login item does not overwrite Stable", async (channel) => {
    const configHome = await mkdtemp(join(tmpdir(), "pi-lab-autostart-"))
    dirs.push(configHome)
    const service = createStartAtLoginService({
      platform: "linux",
      isPackaged: true,
      executable: `/home/user/PI Lab ${channel}.AppImage`,
      channel,
      configHome,
      native: null,
    })
    await service.set(true)
    const entry = await readFile(
      join(configHome, "autostart", `com.pi-lab.desktop.${channel}`),
      "utf8",
    )
    expect(entry).toContain(`Name=PI Lab ${channel === "alpha" ? "Alpha" : "Beta"}`)
    expect(entry).toContain("--pi-lab-background")
  })
})
