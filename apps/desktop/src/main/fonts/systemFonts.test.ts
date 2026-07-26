import { describe, expect, test, vi } from "vitest"
import {
  cacheSystemFontDetector,
  createSystemFontDetector,
  type SystemFontExec,
} from "./systemFonts"

describe("system font detection", () => {
  test("uses an exact macOS executable/argv tuple and extracts unique font families", async () => {
    const exec = vi.fn<SystemFontExec>().mockResolvedValue({
      stdout: JSON.stringify({
        SPFontsDataType: [
          { typefaces: [{ family: "Menlo" }, { family: "Avenir Next" }] },
          { typefaces: [{ family: "Menlo" }] },
        ],
      }),
    })

    await expect(createSystemFontDetector("darwin", exec)()).resolves.toEqual({
      families: ["Avenir Next", "Menlo"],
      error: null,
    })
    expect(exec).toHaveBeenCalledWith("/usr/sbin/system_profiler", ["SPFontsDataType", "-json"])
  })

  test("uses fontconfig argv on Linux and normalizes comma-separated families", async () => {
    const exec = vi
      .fn<SystemFontExec>()
      .mockResolvedValue({ stdout: "DejaVu Sans Mono,DejaVu Sans\nLiberation Mono\n" })

    await expect(createSystemFontDetector("linux", exec)()).resolves.toEqual({
      families: ["DejaVu Sans", "DejaVu Sans Mono", "Liberation Mono"],
      error: null,
    })
    expect(exec).toHaveBeenCalledWith("fc-list", ["--format=%{family}\\n"])
  })

  test("uses a fixed PowerShell argv on Windows without interpolated user input", async () => {
    const exec = vi
      .fn<SystemFontExec>()
      .mockResolvedValue({ stdout: "Cascadia Mono\r\nConsolas\r\n" })

    await expect(createSystemFontDetector("win32", exec)()).resolves.toEqual({
      families: ["Cascadia Mono", "Consolas"],
      error: null,
    })
    expect(exec).toHaveBeenCalledWith("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -AssemblyName PresentationCore; [System.Windows.Media.Fonts]::SystemFontFamilies | ForEach-Object { $_.Source }",
    ])
  })

  test("treats an empty platform result as detection failure with a safe fallback", async () => {
    const exec = vi.fn<SystemFontExec>().mockResolvedValue({ stdout: "" })

    await expect(createSystemFontDetector("linux", exec)()).resolves.toEqual({
      families: [],
      error: "System fonts could not be detected. The default monospace font is still available.",
    })
  })

  test("returns a renderer-visible fallback error instead of throwing", async () => {
    const exec = vi.fn<SystemFontExec>().mockRejectedValue(new Error("missing executable"))

    await expect(createSystemFontDetector("linux", exec)()).resolves.toEqual({
      families: [],
      error: "System fonts could not be detected. The default monospace font is still available.",
    })
  })

  test("caches one platform scan for the application lifetime", async () => {
    const detector = vi.fn().mockResolvedValue({ families: ["Menlo"], error: null })
    const cached = cacheSystemFontDetector(detector)

    await expect(Promise.all([cached(), cached(), cached()])).resolves.toEqual([
      { families: ["Menlo"], error: null },
      { families: ["Menlo"], error: null },
      { families: ["Menlo"], error: null },
    ])
    expect(detector).toHaveBeenCalledTimes(1)
  })
})
