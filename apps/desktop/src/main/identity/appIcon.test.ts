import { describe, expect, test, vi } from "vitest"
import { applyMacDockIcon, resolveAppIconPath } from "./appIcon"

describe("resolveAppIconPath", () => {
  test("uses the repository master during development", () => {
    const existing: string[] = []
    const path = resolveAppIconPath(
      {
        isPackaged: false,
        resourcesPath: "/Electron/Resources",
        appPath: "/repo/apps/desktop",
      },
      {
        exists: (candidate) => {
          existing.push(candidate)
          return true
        },
      },
    )

    expect(path).toBe("/repo/icons/icon.png")
    expect(existing).toEqual(["/repo/icons/icon.png"])
  })

  test("uses the packaged extra resource without consulting the source tree", () => {
    const path = resolveAppIconPath(
      {
        isPackaged: true,
        resourcesPath: "/Applications/PI Lab.app/Contents/Resources",
        appPath: "/Applications/PI Lab.app/Contents/Resources/app.asar",
      },
      { exists: () => true },
    )

    expect(path).toBe("/Applications/PI Lab.app/Contents/Resources/pi-lab-icon.png")
  })

  test("returns null when the icon is unavailable", () => {
    expect(
      resolveAppIconPath(
        { isPackaged: false, resourcesPath: "/resources", appPath: "/repo/apps/desktop" },
        { exists: () => false },
      ),
    ).toBeNull()
  })
})

describe("applyMacDockIcon", () => {
  test("sets the explicit Dock icon on macOS", () => {
    const setIcon = vi.fn()
    expect(applyMacDockIcon("/repo/icons/icon.png", "darwin", { setIcon }, { warn: vi.fn() })).toBe(
      "applied",
    )
    expect(setIcon).toHaveBeenCalledWith("/repo/icons/icon.png")
  })

  test("skips unsupported platforms and missing icons", () => {
    const setIcon = vi.fn()
    expect(applyMacDockIcon("/repo/icons/icon.png", "linux", { setIcon }, { warn: vi.fn() })).toBe(
      "skipped",
    )
    expect(applyMacDockIcon(null, "darwin", { setIcon }, { warn: vi.fn() })).toBe("skipped")
    expect(setIcon).not.toHaveBeenCalled()
  })

  test("surfaces a Dock failure without crashing app boot", () => {
    const warn = vi.fn()
    const setIcon = vi.fn(() => {
      throw new Error("invalid image")
    })

    expect(applyMacDockIcon("/repo/icons/icon.png", "darwin", { setIcon }, { warn })).toBe("failed")
    expect(warn).toHaveBeenCalledWith("[pi-lab] Dock icon unavailable: invalid image")
  })
})
