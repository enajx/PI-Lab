import { describe, expect, test } from "vitest"
import { buildMainWindowOptions } from "./windowOptions"

describe("buildMainWindowOptions", () => {
  test("sets the resolved Pi icon on the native window", () => {
    expect(
      buildMainWindowOptions("/repo/icons/icon.png", "/repo/out/preload/index.js", "linux", false)
        .icon,
    ).toBe("/repo/icons/icon.png")
  })

  test("omits the native icon cleanly when the asset is unavailable", () => {
    expect(
      buildMainWindowOptions(null, "/repo/out/preload/index.js", "linux", false),
    ).not.toHaveProperty("icon")
  })

  test("retains the macOS hidden inset window chrome", () => {
    const options = buildMainWindowOptions(
      "/repo/icons/icon.png",
      "/repo/out/preload/index.js",
      "darwin",
      false,
    )
    expect(options.titleBarStyle).toBe("hiddenInset")
    expect(options.trafficLightPosition).toEqual({ x: 16, y: 18 })
  })

  test("keeps embedded report and marimo frames outside the Electron capability boundary", () => {
    const preferences = buildMainWindowOptions(
      null,
      "/repo/out/preload/index.js",
      "linux",
      false,
    ).webPreferences

    expect(preferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    })
  })

  test("makes hidden test windows transparent even if a flow shows them", () => {
    const options = buildMainWindowOptions(null, "/repo/out/preload/index.js", "darwin", true)
    expect(options.opacity).toBe(0)
  })
})
