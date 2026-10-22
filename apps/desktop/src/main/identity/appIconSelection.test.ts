import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test, vi } from "vitest"
import { decodeRgbaPng } from "../../../scripts/generate-app-icon"
import {
  APP_ICON_DEFAULT_SELECTION,
  APP_ICON_JOYPLOT_STYLES,
  APP_ICON_PI_FONTS,
  type AppIconSelection,
  applyAppIconFavorite,
  isAppIconSelection,
  matchesAppIconFavorite,
  snapshotAppIconFavorite,
} from "../../shared/appIcon"
import {
  alphaIconNeedsRecolor,
  loadAppIconSelection,
  resolveSelectedAppIconPath,
  resolveStartupAppIcon,
  saveAppIconSelection,
} from "./appIconSelection"

const context = {
  isPackaged: false,
  resourcesPath: "/app/Resources",
  appPath: "/repo/apps/desktop",
}

const ALPHA_DEFAULT_SELECTION: AppIconSelection = {
  ...APP_ICON_DEFAULT_SELECTION,
  alphaWhiteBackground: true,
  joyplotPalette: "viridis",
  piPalette: "viridis",
}

describe("app icon selection", () => {
  test("Alpha resolves one shape master while palette and range controls change", () => {
    const base: AppIconSelection = {
      ...ALPHA_DEFAULT_SELECTION,
      family: "joyplot",
      joyplotStyle: "37",
      joyplotExpanded: true,
    }
    const packaged = { ...context, channel: "alpha" as const, isPackaged: true }
    const source = resolveSelectedAppIconPath(base, packaged, { exists: () => true })
    expect(source).toBe("/app/Resources/app-icon-variants/joyplot-37-viridis-expanded.png")
    for (const changed of [
      { ...base, joyplotPalette: "plasma" as const },
      { ...base, joyplotReverse: true },
      { ...base, joyplotLimitVisibleRange: true },
    ]) {
      expect(resolveSelectedAppIconPath(changed, packaged, { exists: () => true })).toBe(source)
      expect(alphaIconNeedsRecolor(changed)).toBe(true)
    }
  })

  test("snapshots only the factors affecting the active family's final icon", () => {
    const selection: AppIconSelection = {
      ...APP_ICON_DEFAULT_SELECTION,
      family: "joyplot",
      joyplotStyle: "38",
      joyplotPalette: "plasma",
      joyplotExpanded: false,
      joyplotReverse: true,
      joyplotLimitVisibleRange: true,
      piFont: "didot-bold",
      piPalette: "cividis",
      piReverse: true,
      piLimitVisibleRange: false,
    }
    expect(snapshotAppIconFavorite(selection)).toEqual({
      family: "joyplot",
      style: "38",
      palette: "plasma",
      expanded: false,
      reverse: true,
      limitVisibleRange: true,
    })
    expect(snapshotAppIconFavorite({ ...selection, family: "pi" })).toEqual({
      family: "pi",
      font: "didot-bold",
      palette: "cividis",
      reverse: true,
      limitVisibleRange: false,
    })
  })

  test("Alpha favorites distinguish colored and white backgrounds", () => {
    const colored = { ...APP_ICON_DEFAULT_SELECTION, joyplotPalette: "plasma" as const }
    const white = { ...colored, alphaWhiteBackground: true }
    const coloredFavorite = snapshotAppIconFavorite(colored)
    const whiteFavorite = snapshotAppIconFavorite(white)
    expect(whiteFavorite).toMatchObject({ alphaWhiteBackground: true })
    expect(matchesAppIconFavorite(white, coloredFavorite)).toBe(false)
    expect(matchesAppIconFavorite(white, whiteFavorite)).toBe(true)
    expect(applyAppIconFavorite(white, coloredFavorite).alphaWhiteBackground).toBe(false)
    expect(applyAppIconFavorite(colored, whiteFavorite).alphaWhiteBackground).toBe(true)
  })

  test("matches the exact visible icon and restores a favorite without changing inactive choices", () => {
    const selection: AppIconSelection = {
      ...APP_ICON_DEFAULT_SELECTION,
      family: "pi",
      piFont: "didot-bold",
      piPalette: "plasma",
      piReverse: true,
      piLimitVisibleRange: true,
    }
    const favorite = snapshotAppIconFavorite(selection)
    expect(matchesAppIconFavorite(selection, favorite)).toBe(true)
    expect(matchesAppIconFavorite({ ...selection, piReverse: false }, favorite)).toBe(false)
    expect(matchesAppIconFavorite({ ...selection, family: "joyplot" }, favorite)).toBe(false)
    const changed: AppIconSelection = {
      ...APP_ICON_DEFAULT_SELECTION,
      family: "joyplot",
      joyplotStyle: "42",
      joyplotPalette: "cividis",
      joyplotExpanded: false,
      joyplotReverse: true,
      joyplotLimitVisibleRange: true,
    }
    expect(applyAppIconFavorite(changed, favorite)).toEqual({
      ...changed,
      family: "pi",
      piFont: "didot-bold",
      piPalette: "plasma",
      piReverse: true,
      piLimitVisibleRange: true,
    })
  })

  test("discards old theme-only favorites when loading an otherwise valid saved choice", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-lab-icon-choice-"))
    try {
      writeFileSync(
        join(directory, "app-icon-selection.json"),
        JSON.stringify({
          ...APP_ICON_DEFAULT_SELECTION,
          joyplotStyle: "38",
          favoritePalettes: ["plasma", "magma"],
          favoriteIcons: undefined,
        }),
      )
      expect(loadAppIconSelection(directory, { warn: vi.fn() }, "alpha")).toEqual({
        ...APP_ICON_DEFAULT_SELECTION,
        joyplotStyle: "38",
        favoriteIcons: [],
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("rejects incomplete, wrong-family, and duplicate complete favorites", () => {
    const favorite = snapshotAppIconFavorite({ ...APP_ICON_DEFAULT_SELECTION, family: "joyplot" })
    const valid = { ...APP_ICON_DEFAULT_SELECTION, family: "joyplot", favoriteIcons: [favorite] }
    expect(isAppIconSelection(valid)).toBe(true)
    expect(isAppIconSelection({ ...valid, favoriteIcons: [favorite, { ...favorite }] })).toBe(false)
    expect(
      isAppIconSelection({
        ...valid,
        favoriteIcons: [{ ...favorite, expanded: undefined }],
      }),
    ).toBe(false)
    expect(
      isAppIconSelection({
        ...valid,
        favoriteIcons: [{ ...favorite, font: "didot-bold" }],
      }),
    ).toBe(false)
    expect(
      isAppIconSelection({
        ...valid,
        favoriteIcons: [{ ...favorite, palette: "not-a-palette" }],
      }),
    ).toBe(false)
  })

  test("rejects invalid favorites in a saved choice", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-lab-icon-choice-"))
    const warn = vi.fn()
    try {
      writeFileSync(
        join(directory, "app-icon-selection.json"),
        JSON.stringify({
          ...APP_ICON_DEFAULT_SELECTION,
          favoriteIcons: [
            {
              family: "pi",
              font: "didot-bold",
              palette: "not-a-palette",
              reverse: false,
              limitVisibleRange: false,
            },
          ],
        }),
      )
      expect(loadAppIconSelection(directory, { warn }, "alpha")).toEqual(ALPHA_DEFAULT_SELECTION)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("uses Gill Sans Pi in solid #303030 as the Stable default", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-lab-icon-choice-"))
    try {
      expect(APP_ICON_DEFAULT_SELECTION).toMatchObject({
        family: "pi",
        joyplotStyle: "25",
        joyplotPalette: "magma",
        joyplotExpanded: true,
        joyplotReverse: false,
        piFont: "gill-sans-regular",
        piPalette: "gray-30",
        piReverse: false,
      })
      expect(loadAppIconSelection(directory, { warn: vi.fn() }, "stable")).toEqual(
        APP_ICON_DEFAULT_SELECTION,
      )
      expect(
        resolveSelectedAppIconPath(APP_ICON_DEFAULT_SELECTION, context, { exists: () => true }),
      ).toBe("/repo/apps/desktop/assets/icons/icon.png")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("ignores saved icon choices in Stable and Beta", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-lab-public-icon-choice-"))
    try {
      saveAppIconSelection(directory, {
        ...APP_ICON_DEFAULT_SELECTION,
        family: "joyplot",
        joyplotPalette: "plasma",
      })
      for (const channel of ["stable", "beta"] as const) {
        expect(loadAppIconSelection(directory, { warn: vi.fn() }, channel)).toEqual(
          APP_ICON_DEFAULT_SELECTION,
        )
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("starts Alpha with Gill Sans in viridis on white but keeps later palette choices", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-lab-alpha-icon-choice-"))
    try {
      expect(loadAppIconSelection(directory, { warn: vi.fn() }, "alpha")).toMatchObject({
        family: "pi",
        alphaWhiteBackground: true,
        piFont: "gill-sans-regular",
        joyplotPalette: "viridis",
        piPalette: "viridis",
      })
      const selected = { ...APP_ICON_DEFAULT_SELECTION, joyplotPalette: "plasma" as const }
      saveAppIconSelection(directory, selected)
      expect(loadAppIconSelection(directory, { warn: vi.fn() }, "alpha")).toEqual(selected)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("persists both families' selections across a new read", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-lab-icon-choice-"))
    const selection: AppIconSelection = {
      family: "pi",
      alphaWhiteBackground: true,
      joyplotStyle: "31",
      joyplotPalette: "magma-iris",
      joyplotExpanded: true,
      joyplotReverse: true,
      joyplotLimitVisibleRange: true,
      piFont: "didot-bold",
      piPalette: "viridis",
      piReverse: false,
      piLimitVisibleRange: true,
      favoriteIcons: [
        {
          family: "pi",
          font: "didot-bold",
          palette: "viridis",
          reverse: false,
          limitVisibleRange: true,
        },
      ],
    }
    try {
      saveAppIconSelection(directory, selection)
      expect(loadAppIconSelection(directory, { warn: vi.fn() }, "alpha")).toEqual(selection)
      expect(readFileSync(join(directory, "app-icon-selection.json"), "utf8")).toContain(
        '"piFont": "didot-bold"',
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("recovers from a damaged saved choice and lets the app open", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-lab-icon-choice-"))
    const warn = vi.fn()
    try {
      writeFileSync(join(directory, "app-icon-selection.json"), "{broken")
      expect(loadAppIconSelection(directory, { warn }, "alpha")).toEqual(ALPHA_DEFAULT_SELECTION)
      expect(warn).toHaveBeenCalledOnce()
      writeFileSync(join(directory, "app-icon-selection.json"), '{"family":"old"}')
      expect(loadAppIconSelection(directory, { warn }, "alpha")).toEqual(ALPHA_DEFAULT_SELECTION)
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("keeps older saved choices and defaults Expanded and Reverse to off", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-lab-icon-choice-"))
    try {
      writeFileSync(
        join(directory, "app-icon-selection.json"),
        JSON.stringify({
          family: "joyplot",
          joyplotStyle: "31",
          joyplotPalette: "magma",
          piFont: "didot-bold",
          piPalette: "viridis",
        }),
      )
      expect(loadAppIconSelection(directory, { warn: vi.fn() }, "alpha")).toEqual({
        family: "joyplot",
        alphaWhiteBackground: false,
        joyplotStyle: "31",
        joyplotPalette: "magma",
        joyplotExpanded: false,
        joyplotReverse: false,
        joyplotLimitVisibleRange: false,
        piFont: "didot-bold",
        piPalette: "viridis",
        piReverse: false,
        piLimitVisibleRange: false,
        favoriteIcons: [],
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("retiring an old Joyplot style keeps the saved Pi font and palette", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-lab-icon-choice-"))
    const warn = vi.fn()
    try {
      writeFileSync(
        join(directory, "app-icon-selection.json"),
        JSON.stringify({
          family: "pi",
          joyplotStyle: "22",
          joyplotPalette: "magma-iris",
          piFont: "didot-bold",
          piPalette: "magma",
        }),
      )
      expect(loadAppIconSelection(directory, { warn }, "alpha")).toEqual({
        family: "pi",
        alphaWhiteBackground: false,
        joyplotStyle: "25",
        joyplotPalette: "magma",
        joyplotExpanded: true,
        joyplotReverse: false,
        joyplotLimitVisibleRange: false,
        piFont: "didot-bold",
        piPalette: "magma",
        piReverse: false,
        piLimitVisibleRange: false,
        favoriteIcons: [],
      })
      expect(
        JSON.parse(readFileSync(join(directory, "app-icon-selection.json"), "utf8")),
      ).toMatchObject({
        joyplotStyle: "25",
        piFont: "didot-bold",
      })
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("migrates the former installed style to the new default and keeps Pi choices", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-lab-icon-choice-"))
    const warn = vi.fn()
    try {
      writeFileSync(
        join(directory, "app-icon-selection.json"),
        JSON.stringify({
          family: "pi",
          joyplotStyle: "16",
          joyplotPalette: "viridis",
          joyplotExpanded: false,
          piFont: "didot-bold",
          piPalette: "magma-iris",
        }),
      )
      expect(loadAppIconSelection(directory, { warn }, "alpha")).toEqual({
        family: "pi",
        alphaWhiteBackground: false,
        joyplotStyle: "25",
        joyplotPalette: "magma",
        joyplotExpanded: true,
        joyplotReverse: false,
        joyplotLimitVisibleRange: false,
        piFont: "didot-bold",
        piPalette: "magma-iris",
        piReverse: false,
        piLimitVisibleRange: false,
        favoriteIcons: [],
      })
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("resolves a selected PNG in development and packaged resources", () => {
    const selection: AppIconSelection = {
      ...APP_ICON_DEFAULT_SELECTION,
      family: "pi",
      piFont: "didot-bold",
      piPalette: "magma",
    }
    const expected =
      "/repo/apps/desktop/src/renderer/routes/_shell/settings/components/AppIconGallery/icons/pi-didot-bold-magma.png"
    expect(
      resolveSelectedAppIconPath(selection, context, { exists: (path) => path === expected }),
    ).toBe(expected)
    expect(
      resolveSelectedAppIconPath(
        selection,
        { ...context, isPackaged: true },
        { exists: () => true },
      ),
    ).toBe("/app/Resources/app-icon-variants/pi-didot-bold-magma.png")
  })

  test("keeps Alpha's selected palette and uses Beta's fixed built-in icon", () => {
    const selection: AppIconSelection = {
      ...APP_ICON_DEFAULT_SELECTION,
      family: "pi",
      piFont: "didot-bold",
      piPalette: "plasma",
      favoriteIcons: [
        {
          family: "pi",
          font: "didot-bold",
          palette: "plasma",
          reverse: false,
          limitVisibleRange: false,
        },
      ],
    }
    const alpha = selection
    expect(alpha.piPalette).toBe("plasma")
    expect(alpha.joyplotPalette).toBe(selection.joyplotPalette)
    expect(alpha.favoriteIcons[0]).toMatchObject({ palette: "plasma", font: "didot-bold" })
    expect(selection.piPalette).toBe("plasma")
    expect(
      resolveSelectedAppIconPath(
        APP_ICON_DEFAULT_SELECTION,
        { ...context, channel: "beta", isPackaged: true },
        { exists: () => true },
      ),
    ).toBe("/app/Resources/pi-lab-icon.png")
    expect(
      resolveSelectedAppIconPath(alpha, { ...context, channel: "alpha" }, { exists: () => true }),
    ).toBe(
      "/repo/apps/desktop/src/renderer/routes/_shell/settings/components/AppIconGallery/channel-icons/pi-didot-bold-alpha.png",
    )
    expect(
      resolveSelectedAppIconPath(
        alpha,
        { ...context, channel: "alpha", isPackaged: true },
        { exists: () => true },
      ),
    ).toBe("/app/Resources/app-icon-channel-variants/pi-didot-bold-alpha.png")
    expect(
      resolveSelectedAppIconPath(
        { ...alpha, family: "joyplot", joyplotStyle: "32", joyplotReverse: true },
        { ...context, channel: "alpha", isPackaged: true },
        { exists: () => true },
      ),
    ).toBe("/app/Resources/app-icon-channel-variants/joyplot-32-alpha-expanded.png")
  })

  test("uses one white-background shape master for Alpha's palettes", () => {
    const selection = {
      ...APP_ICON_DEFAULT_SELECTION,
      family: "joyplot" as const,
      alphaWhiteBackground: true,
    }
    expect(
      resolveSelectedAppIconPath(
        selection,
        { ...context, channel: "alpha", isPackaged: true },
        { exists: () => true },
      ),
    ).toBe("/app/Resources/app-icon-variants/joyplot-25-viridis-expanded.png")
    expect(
      resolveSelectedAppIconPath(
        { ...selection, family: "pi", piPalette: "magma" },
        { ...context, channel: "alpha", isPackaged: true },
        { exists: () => true },
      ),
    ).toBe("/app/Resources/app-icon-variants/pi-gill-sans-regular-viridis.png")
    expect(
      resolveSelectedAppIconPath(
        { ...selection, joyplotPalette: "magma-iris" },
        { ...context, channel: "alpha", isPackaged: true },
        { exists: () => true },
      ),
    ).toBe("/app/Resources/app-icon-variants/joyplot-25-viridis-expanded.png")
    expect(
      resolveSelectedAppIconPath(
        { ...selection, joyplotPalette: "plasma" },
        { ...context, channel: "alpha", isPackaged: true },
        { exists: () => true },
      ),
    ).toBe("/app/Resources/app-icon-variants/joyplot-25-viridis-expanded.png")
    expect(
      resolveSelectedAppIconPath(
        { ...selection, alphaWhiteBackground: false },
        { ...context, channel: "alpha", isPackaged: true },
        { exists: () => true },
      ),
    ).toBe("/app/Resources/app-icon-channel-variants/joyplot-25-alpha-expanded.png")
  })

  test("resolves reversed icons for each family without using the canonical icon", () => {
    expect(
      resolveSelectedAppIconPath(
        { ...APP_ICON_DEFAULT_SELECTION, family: "joyplot", joyplotReverse: true },
        { ...context, isPackaged: true },
        { exists: () => true },
      ),
    ).toBe("/app/Resources/app-icon-variants/joyplot-25-magma-reversed-expanded.png")
    expect(
      resolveSelectedAppIconPath(
        { ...APP_ICON_DEFAULT_SELECTION, family: "pi", piReverse: true },
        { ...context, isPackaged: true },
        { exists: () => true },
      ),
    ).toBe("/app/Resources/app-icon-variants/pi-gill-sans-regular-gray-30-reversed.png")
  })

  test("resolves limited-range icons for each family without changing the default icon", () => {
    expect(
      resolveSelectedAppIconPath(
        { ...APP_ICON_DEFAULT_SELECTION, family: "joyplot", joyplotLimitVisibleRange: true },
        { ...context, isPackaged: true },
        { exists: () => true },
      ),
    ).toBe("/app/Resources/app-icon-variants/joyplot-25-magma-limited-expanded.png")
    expect(
      resolveSelectedAppIconPath(
        {
          ...APP_ICON_DEFAULT_SELECTION,
          family: "pi",
          piReverse: true,
          piLimitVisibleRange: true,
        },
        { ...context, isPackaged: true },
        { exists: () => true },
      ),
    ).toBe("/app/Resources/app-icon-variants/pi-gill-sans-regular-gray-30-reversed-limited.png")
    expect(
      resolveSelectedAppIconPath(APP_ICON_DEFAULT_SELECTION, context, { exists: () => true }),
    ).toBe("/repo/apps/desktop/assets/icons/icon.png")
  })

  test("resolves the installed choice and other expanded Joyplot PNGs", () => {
    const selection: AppIconSelection = { ...APP_ICON_DEFAULT_SELECTION }
    expect(resolveSelectedAppIconPath(selection, context, { exists: () => true })).toBe(
      "/repo/apps/desktop/assets/icons/icon.png",
    )
    expect(
      resolveSelectedAppIconPath(
        { ...selection, family: "joyplot", joyplotStyle: "35", joyplotPalette: "magma" },
        { ...context, isPackaged: true },
        { exists: () => true },
      ),
    ).toBe("/app/Resources/app-icon-variants/joyplot-35-magma-expanded.png")
  })

  test("rejects a missing selected icon instead of silently applying a different one", () => {
    const selection: AppIconSelection = {
      ...APP_ICON_DEFAULT_SELECTION,
      family: "joyplot",
      joyplotStyle: "32",
    }
    expect(() => resolveSelectedAppIconPath(selection, context, { exists: () => false })).toThrow(
      "selected app icon is missing",
    )
  })

  test("opens with the default if a saved variant is missing", () => {
    const selected: AppIconSelection = {
      ...APP_ICON_DEFAULT_SELECTION,
      family: "joyplot",
      joyplotStyle: "32",
    }
    const warn = vi.fn()
    const resolved = resolveStartupAppIcon(
      selected,
      context,
      {
        exists: (path) => path === "/repo/apps/desktop/assets/icons/icon.png",
      },
      { warn },
    )
    expect(resolved).toEqual({
      selection: APP_ICON_DEFAULT_SELECTION,
      path: "/repo/apps/desktop/assets/icons/icon.png",
    })
    expect(warn).toHaveBeenCalledOnce()
  })

  test("falls back to the channel palette when an Alpha icon choice is missing", () => {
    const selected: AppIconSelection = {
      ...APP_ICON_DEFAULT_SELECTION,
      family: "joyplot",
      joyplotStyle: "32",
    }
    const resolved = resolveStartupAppIcon(
      selected,
      { ...context, channel: "alpha" },
      { exists: (path) => path === "/repo/apps/desktop/assets/icons/icon-alpha.png" },
      { warn: vi.fn() },
    )
    expect(resolved.selection).toMatchObject({ joyplotPalette: "viridis", piPalette: "viridis" })
    expect(resolved.path).toBe("/repo/apps/desktop/assets/icons/icon-alpha.png")
  })

  test("each supported shape has one 256px master per background style", () => {
    const gallery = join(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      "src/renderer/routes/_shell/settings/components/AppIconGallery",
    )
    const white = join(gallery, "icons")
    const colored = join(gallery, "channel-icons")
    const whiteNames = [
      ...APP_ICON_JOYPLOT_STYLES.flatMap((style) => [
        `joyplot-${style}-viridis.png`,
        `joyplot-${style}-viridis-expanded.png`,
      ]),
      ...APP_ICON_PI_FONTS.map((font) => `pi-${font}-viridis.png`),
    ].sort()
    const coloredNames = [
      ...APP_ICON_JOYPLOT_STYLES.flatMap((style) => [
        `joyplot-${style}-alpha.png`,
        `joyplot-${style}-alpha-expanded.png`,
      ]),
      ...APP_ICON_PI_FONTS.map((font) => `pi-${font}-alpha.png`),
    ].sort()
    expect(readdirSync(white).sort()).toEqual(whiteNames)
    expect(readdirSync(colored).sort()).toEqual(coloredNames)
    for (const [directory, names] of [
      [white, whiteNames],
      [colored, coloredNames],
    ] as const) {
      for (const name of names) {
        const png = decodeRgbaPng(join(directory, name))
        expect([png.width, png.height]).toEqual([256, 256])
      }
    }
    for (const removed of ["06", "07", "13", "14", "16", "19", "20", "21", "22", "23"]) {
      expect(existsSync(join(white, `joyplot-${removed}-viridis.png`))).toBe(false)
    }
  })

  test("Expanded Joyplot artwork widens and keeps most vertical margin", () => {
    const icons = join(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      "src/renderer/routes/_shell/settings/components/AppIconGallery/icons",
    )
    for (const style of APP_ICON_JOYPLOT_STYLES) {
      const normal = decodeRgbaPng(join(icons, `joyplot-${style}-viridis.png`))
      const expanded = decodeRgbaPng(join(icons, `joyplot-${style}-viridis-expanded.png`))
      const bounds = (pixels: Uint8Array) => {
        let left = 256
        let top = 256
        let right = 0
        let bottom = 0
        for (let y = 0; y < 256; y++) {
          for (let x = 0; x < 256; x++) {
            const offset = (y * 256 + x) * 4
            const colored =
              pixels[offset + 3] === 255 &&
              Math.min(
                pixels[offset] ?? 255,
                pixels[offset + 1] ?? 255,
                pixels[offset + 2] ?? 255,
              ) < 220
            if (!colored) continue
            left = Math.min(left, x)
            top = Math.min(top, y)
            right = Math.max(right, x)
            bottom = Math.max(bottom, y)
          }
        }
        return { left, top, right, bottom }
      }
      const regularBounds = bounds(normal.pixels)
      const expandedBounds = bounds(expanded.pixels)
      expect(expandedBounds.left, style).toBeLessThan(regularBounds.left)
      expect(expandedBounds.right, style).toBeGreaterThan(regularBounds.right)
      const tileTop = 16
      const tileBottom = 239
      const regularTopMargin = regularBounds.top - tileTop
      const regularBottomMargin = tileBottom - regularBounds.bottom
      const expandedTopMargin = expandedBounds.top - tileTop
      const expandedBottomMargin = tileBottom - expandedBounds.bottom
      expect(expandedTopMargin, style).toBeGreaterThan(regularTopMargin * 0.62)
      expect(expandedTopMargin, style).toBeLessThan(regularTopMargin * 0.82)
      expect(expandedBottomMargin, style).toBeGreaterThan(regularBottomMargin * 0.62)
      expect(expandedBottomMargin, style).toBeLessThan(regularBottomMargin * 0.82)
      expect(expandedBounds.left, style).toBeLessThanOrEqual(38)
      expect(expandedBounds.right, style).toBeGreaterThanOrEqual(218)
      expect(expandedBounds.left, style).toBeGreaterThanOrEqual(16)
      expect(expandedBounds.right, style).toBeLessThanOrEqual(239)
    }
  })
})
