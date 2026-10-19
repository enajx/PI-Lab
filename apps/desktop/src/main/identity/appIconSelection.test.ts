import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test, vi } from "vitest"
import { decodeRgbaPng } from "../../../scripts/generate-app-icon"
import {
  APP_ICON_DEFAULT_SELECTION,
  APP_ICON_JOYPLOT_STYLES,
  APP_ICON_PALETTES,
  APP_ICON_PI_FONTS,
  type AppIconSelection,
  applyAppIconFavorite,
  isAppIconSelection,
  matchesAppIconFavorite,
  snapshotAppIconFavorite,
} from "../../shared/appIcon"
import {
  loadAppIconSelection,
  normalizeAppIconSelectionForChannel,
  resolveSelectedAppIconPath,
  resolveStartupAppIcon,
  saveAppIconSelection,
} from "./appIconSelection"

const context = {
  isPackaged: false,
  resourcesPath: "/app/Resources",
  appPath: "/repo/apps/desktop",
}

describe("app icon selection", () => {
  test("snapshots only the factors affecting the active family's final icon", () => {
    const selection: AppIconSelection = {
      ...APP_ICON_DEFAULT_SELECTION,
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
      expect(loadAppIconSelection(directory, { warn: vi.fn() })).toEqual({
        ...APP_ICON_DEFAULT_SELECTION,
        joyplotStyle: "38",
        favoriteIcons: [],
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("rejects incomplete, wrong-family, and duplicate complete favorites", () => {
    const favorite = snapshotAppIconFavorite(APP_ICON_DEFAULT_SELECTION)
    const valid = { ...APP_ICON_DEFAULT_SELECTION, favoriteIcons: [favorite] }
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
      expect(loadAppIconSelection(directory, { warn })).toEqual(APP_ICON_DEFAULT_SELECTION)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("uses expanded joyplot style 25 in Magma as the default", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-lab-icon-choice-"))
    try {
      expect(APP_ICON_DEFAULT_SELECTION).toMatchObject({
        family: "joyplot",
        joyplotStyle: "25",
        joyplotPalette: "magma",
        joyplotExpanded: true,
        joyplotReverse: false,
        piFont: "helvetica-neue-medium",
        piReverse: false,
      })
      expect(loadAppIconSelection(directory, { warn: vi.fn() })).toEqual(APP_ICON_DEFAULT_SELECTION)
      expect(
        resolveSelectedAppIconPath(APP_ICON_DEFAULT_SELECTION, context, { exists: () => true }),
      ).toBe("/repo/icons/icon.png")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("persists both families' selections across a new read", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-lab-icon-choice-"))
    const selection: AppIconSelection = {
      family: "pi",
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
      expect(loadAppIconSelection(directory, { warn: vi.fn() })).toEqual(selection)
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
      expect(loadAppIconSelection(directory, { warn })).toEqual(APP_ICON_DEFAULT_SELECTION)
      expect(warn).toHaveBeenCalledOnce()
      writeFileSync(join(directory, "app-icon-selection.json"), '{"family":"old"}')
      expect(loadAppIconSelection(directory, { warn })).toEqual(APP_ICON_DEFAULT_SELECTION)
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
      expect(loadAppIconSelection(directory, { warn: vi.fn() })).toEqual({
        family: "joyplot",
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
      expect(loadAppIconSelection(directory, { warn })).toEqual({
        family: "pi",
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
      expect(loadAppIconSelection(directory, { warn })).toEqual({
        family: "pi",
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

  test("keeps Alpha palette fixed and shares Beta's selected color with Stable", () => {
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
    const alpha = normalizeAppIconSelectionForChannel(selection, "alpha")
    expect(alpha.piPalette).toBe("viridis")
    expect(alpha.joyplotPalette).toBe("viridis")
    expect(alpha.favoriteIcons[0]).toMatchObject({ palette: "viridis", font: "didot-bold" })
    expect(selection.piPalette).toBe("plasma")
    expect(normalizeAppIconSelectionForChannel(selection, "beta")).toEqual(selection)
    expect(normalizeAppIconSelectionForChannel(selection, "stable")).toEqual(selection)
    expect(
      resolveSelectedAppIconPath(
        APP_ICON_DEFAULT_SELECTION,
        { ...context, channel: "beta", isPackaged: true },
        { exists: () => true },
      ),
    ).toBe("/app/Resources/app-icon-channel-variants/joyplot-25-beta-expanded.png")
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
    ).toBe("/app/Resources/app-icon-channel-variants/joyplot-32-alpha-reversed-expanded.png")
  })

  test("resolves reversed icons for each family without using the canonical icon", () => {
    expect(
      resolveSelectedAppIconPath(
        { ...APP_ICON_DEFAULT_SELECTION, joyplotReverse: true },
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
    ).toBe("/app/Resources/app-icon-variants/pi-helvetica-neue-medium-viridis-reversed.png")
  })

  test("resolves limited-range icons for each family without changing the default icon", () => {
    expect(
      resolveSelectedAppIconPath(
        { ...APP_ICON_DEFAULT_SELECTION, joyplotLimitVisibleRange: true },
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
    ).toBe("/app/Resources/app-icon-variants/pi-helvetica-neue-medium-viridis-reversed-limited.png")
    expect(
      resolveSelectedAppIconPath(APP_ICON_DEFAULT_SELECTION, context, { exists: () => true }),
    ).toBe("/repo/icons/icon.png")
  })

  test("resolves the installed choice and other expanded Joyplot PNGs", () => {
    const selection: AppIconSelection = { ...APP_ICON_DEFAULT_SELECTION }
    expect(resolveSelectedAppIconPath(selection, context, { exists: () => true })).toBe(
      "/repo/icons/icon.png",
    )
    expect(
      resolveSelectedAppIconPath(
        { ...selection, joyplotStyle: "35", joyplotPalette: "magma" },
        { ...context, isPackaged: true },
        { exists: () => true },
      ),
    ).toBe("/app/Resources/app-icon-variants/joyplot-35-magma-expanded.png")
  })

  test("rejects a missing selected icon instead of silently applying a different one", () => {
    const selection: AppIconSelection = { ...APP_ICON_DEFAULT_SELECTION, joyplotStyle: "32" }
    expect(() => resolveSelectedAppIconPath(selection, context, { exists: () => false })).toThrow(
      "selected app icon is missing",
    )
  })

  test("opens with the default if a saved variant is missing", () => {
    const selected: AppIconSelection = { ...APP_ICON_DEFAULT_SELECTION, joyplotStyle: "32" }
    const warn = vi.fn()
    const resolved = resolveStartupAppIcon(
      selected,
      context,
      {
        exists: (path) => path === "/repo/icons/icon.png",
      },
      { warn },
    )
    expect(resolved).toEqual({
      selection: APP_ICON_DEFAULT_SELECTION,
      path: "/repo/icons/icon.png",
    })
    expect(warn).toHaveBeenCalledOnce()
  })

  test("falls back to the channel palette when an Alpha icon choice is missing", () => {
    const selected: AppIconSelection = { ...APP_ICON_DEFAULT_SELECTION, joyplotStyle: "32" }
    const resolved = resolveStartupAppIcon(
      selected,
      { ...context, channel: "alpha" },
      { exists: (path) => path === "/repo/icons/icon-alpha.png" },
      { warn: vi.fn() },
    )
    expect(resolved.selection).toMatchObject({ joyplotPalette: "viridis", piPalette: "viridis" })
    expect(resolved.path).toBe("/repo/icons/icon-alpha.png")
  })

  test("every listed choice has a 256px runtime PNG and removed styles stay absent", () => {
    const icons = join(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      "src/renderer/routes/_shell/settings/components/AppIconGallery/icons",
    )
    expect(
      readdirSync(icons)
        .filter((name) => name.startsWith("joyplot-"))
        .sort(),
    ).toEqual(
      [
        ...APP_ICON_JOYPLOT_STYLES.flatMap((style) =>
          APP_ICON_PALETTES.flatMap((palette) =>
            [false, true].flatMap((reverse) =>
              [false, true].flatMap((limited) => [
                `joyplot-${style}-${palette}${reverse ? "-reversed" : ""}${limited ? "-limited" : ""}.png`,
                `joyplot-${style}-${palette}${reverse ? "-reversed" : ""}${limited ? "-limited" : ""}-expanded.png`,
              ]),
            ),
          ),
        ),
      ].sort(),
    )
    for (const palette of APP_ICON_PALETTES) {
      const png = decodeRgbaPng(join(icons, `joyplot-25-${palette}-reversed-expanded.png`))
      expect([png.width, png.height]).toEqual([256, 256])
    }
    expect(
      readdirSync(icons)
        .filter((name) => name.startsWith("pi-"))
        .sort(),
    ).toEqual(
      APP_ICON_PI_FONTS.flatMap((font) =>
        APP_ICON_PALETTES.flatMap((palette) =>
          [false, true].flatMap((reverse) => [
            `pi-${font}-${palette}${reverse ? "-reversed" : ""}.png`,
            `pi-${font}-${palette}${reverse ? "-reversed" : ""}-limited.png`,
          ]),
        ),
      ).sort(),
    )
    for (const palette of APP_ICON_PALETTES) {
      for (const reverse of [false, true]) {
        for (const limited of [false, true]) {
          const png = readFileSync(
            join(
              icons,
              `pi-helvetica-neue-medium-${palette}${reverse ? "-reversed" : ""}${limited ? "-limited" : ""}.png`,
            ),
          )
          expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
          expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([256, 256])
        }
      }
    }
    for (const removed of [
      "01",
      "02",
      "03",
      "04",
      "05",
      "06",
      "07",
      "08",
      "09",
      "10",
      "11",
      "12",
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      "19",
      "20",
      "21",
      "22",
      "23",
      "24",
    ]) {
      expect(existsSync(join(icons, `joyplot-${removed}-viridis.png`))).toBe(false)
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
