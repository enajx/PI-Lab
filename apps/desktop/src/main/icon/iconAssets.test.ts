import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import {
  decodeRgbaPng,
  generateAppIcons,
  validateIconSources,
} from "../../../scripts/generate-app-icon"
import { APP_ICON_JOYPLOT_STYLES, APP_ICON_PALETTES } from "../../shared/appIcon"

const CANDIDATE_PALETTES = ["magma", "magma-iris", "viridis"] as const

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = resolve(HERE, "..", "..", "..")
const REPO_ROOT = resolve(DESKTOP_DIR, "..", "..")
const ICONS_DIR = join(REPO_ROOT, "icons")
const LEGACY_ICON_PATHS = [
  "icon_bw.png",
  "icon_bw_negative.png",
  "icon_bw_alpha.png",
  "icon_bw_negative_alpha.png",
  "icon_color_black.png",
  "icon_color_white.png",
  "icon_color_white_r.png",
  "icon_old.png",
  "wave.icon",
] as const

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function pixelAt(
  pixels: Uint8Array,
  width: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const offset = (y * width + x) * 4
  const bytes = new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength)
  return [
    bytes.getUint8(offset),
    bytes.getUint8(offset + 1),
    bytes.getUint8(offset + 2),
    bytes.getUint8(offset + 3),
  ]
}

describe("canonical PI Lab application icon", () => {
  test("pins all Matplotlib samples but offers only the retained themes", () => {
    const data = JSON.parse(
      readFileSync(join(REPO_ROOT, "icons-temp/matplotlib-colormaps-3.11.2.json"), "utf8"),
    ) as {
      matplotlib_version: string
      samples: number
      palettes: Record<string, string[]>
      categories: Record<string, string[]>
    }
    expect(data.matplotlib_version).toBe("3.11.2")
    expect(data.samples).toBe(256)
    expect(Object.keys(data.palettes)).toHaveLength(85)
    const removed = new Set([...(data.categories.Qualitative ?? []), "flag", "prism"])
    expect(removed.size).toBe(15)
    expect(
      Object.keys(data.palettes)
        .filter((name) => !removed.has(name))
        .sort(),
    ).toEqual([...APP_ICON_PALETTES].sort())
    expect(data.palettes.viridis?.[0]).toBe("#440154")
    expect(data.palettes.viridis?.at(-1)).toBe("#fde725")
    for (const colors of Object.values(data.palettes)) expect(colors).toHaveLength(256)
  })

  test("excludes retired branding while preserving the canonical icon and motif prototypes", () => {
    for (const legacyPath of LEGACY_ICON_PATHS) {
      expect(existsSync(join(ICONS_DIR, legacyPath)), `${legacyPath} should be removed`).toBe(false)
    }

    for (const retainedPath of [
      "icon.png",
      "icon.svg",
      "icon.manifest.json",
      "motifs.icon",
      "motifs2.icon",
      "motifs3.icon",
    ]) {
      expect(existsSync(join(ICONS_DIR, retainedPath)), `${retainedPath} should be retained`).toBe(
        true,
      )
    }
  })

  test("pins the expanded joyplot style 25 magma vector and its committed PNG derivative", () => {
    const manifest = validateIconSources()
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      master: { path: "icons/icon.svg" },
      derivative: { path: "icons/icon.png", width: 1024, height: 1024 },
    })
    expect(sha256(join(REPO_ROOT, manifest.master.path))).toBe(manifest.master.sha256)
    expect(sha256(join(REPO_ROOT, manifest.derivative.path))).toBe(manifest.derivative.sha256)

    const svg = readFileSync(join(ICONS_DIR, "icon.svg"), "utf8")
    expect(svg).toContain("joyplot icon: style 25, ascending peaks, magma, expanded")
    expect(svg).toContain('stroke="#fff"')
    expect(svg).toContain('stop-color="#000004"')
    expect(svg).toContain('id="expanded-tile"')
    expect(svg).toContain("<path")
    expect(svg).not.toMatch(/<(?:text|image)\b/)
    expect(readFileSync(join(ICONS_DIR, "ICON-PROVENANCE.md"), "utf8")).toContain("style 25")
  })

  test("uses the chosen joyplot raster on a light tile with transparent corners", () => {
    const icon = decodeRgbaPng(join(ICONS_DIR, "icon.png"))
    expect([icon.width, icon.height]).toEqual([1024, 1024])
    expect(pixelAt(icon.pixels, icon.width, 0, 0)).toEqual([0, 0, 0, 0])
    expect(pixelAt(icon.pixels, icon.width, 1023, 1023)).toEqual([0, 0, 0, 0])
    expect(pixelAt(icon.pixels, icon.width, 512, 100)).toEqual([255, 255, 255, 255])
    expect(pixelAt(icon.pixels, icon.width, 512, 512)).toEqual([182, 58, 116, 255])
    expect(
      existsSync(join(REPO_ROOT, "icons-temp/joyplot-candidates/16-shifting-crest-viridis.png")),
    ).toBe(false)
  })

  test("candidate folder contains only the two-to-four-ridge styles", () => {
    const directory = join(REPO_ROOT, "icons-temp/joyplot-candidates")
    const vectors = readdirSync(directory).filter((name) => /^\d\d-.*\.svg$/.test(name))
    const rasters = readdirSync(directory).filter((name) => /^\d\d-.*\.png$/.test(name))
    expect(vectors).toHaveLength(84)
    expect(rasters).toHaveLength(84)
    for (const style of APP_ICON_JOYPLOT_STYLES) {
      for (const palette of CANDIDATE_PALETTES) {
        const name = vectors.find(
          (file) => file.startsWith(`${style}-`) && file.endsWith(`-${palette}.svg`),
        )
        expect(name).toBeDefined()
        const svg = readFileSync(join(directory, name as string), "utf8")
        const ridges = (svg.match(/fill="url\(#fill\)"/g) ?? []).length
        expect(ridges).toBeGreaterThanOrEqual(2)
        expect(ridges).toBeLessThanOrEqual(4)
      }
    }
  })

  test("style 37 keeps style 25's center ridge and broadens the outer tails", () => {
    const directory = join(REPO_ROOT, "icons-temp/joyplot-candidates")
    const filledPaths = (name: string) => {
      const svg = readFileSync(join(directory, name), "utf8")
      return [...svg.matchAll(/<path d="([^"]+)" fill="url\(#fill\)"\/>/g)].map((match) =>
        [...(match[1] ?? "").matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map((point) => [
          Number(point[1]),
          Number(point[2]),
        ]),
      )
    }
    const original = filledPaths("25-ascending-peaks-magma.svg")
    const rounded = filledPaths("37-rounder-tails-magma.svg")
    expect(rounded).toHaveLength(3)
    expect(rounded[1]).toEqual(original[1])
    for (const row of [0, 2]) {
      const area = (points: number[][]) => {
        const baseline = points[0]?.[1] ?? 0
        return points.reduce((total, point) => total + baseline - (point[1] ?? baseline), 0)
      }
      expect(area(rounded[row] ?? []), `row ${row}`).toBeGreaterThan(
        area(original[row] ?? []) * 1.12,
      )
    }
    const previews = join(
      DESKTOP_DIR,
      "src/renderer/routes/_shell/settings/components/AppIconGallery/icons",
    )
    const expanded25 = decodeRgbaPng(join(previews, "joyplot-25-magma-expanded.png"))
    const expanded37 = decodeRgbaPng(join(previews, "joyplot-37-magma-expanded.png"))
    const middleRidgeStart = 100 * 256 * 4
    const middleRidgeEnd = 138 * 256 * 4
    expect(expanded37.pixels.subarray(middleRidgeStart, middleRidgeEnd)).toEqual(
      expanded25.pixels.subarray(middleRidgeStart, middleRidgeEnd),
    )
  })

  test("Viridis shows both purple and yellow on the expanded Joyplot", () => {
    const preview = decodeRgbaPng(
      join(
        DESKTOP_DIR,
        "src/renderer/routes/_shell/settings/components/AppIconGallery/icons/joyplot-25-viridis-expanded.png",
      ),
    )
    let purplePixels = 0
    let yellowPixels = 0
    for (let index = 0; index < preview.pixels.length; index += 4) {
      const red = preview.pixels[index] ?? 0
      const green = preview.pixels[index + 1] ?? 0
      const blue = preview.pixels[index + 2] ?? 0
      const alpha = preview.pixels[index + 3] ?? 0
      if (alpha === 255 && red < 90 && green < 60 && blue > 50 && blue < 150) purplePixels++
      if (alpha === 255 && red > 150 && green > 160 && blue < 100) yellowPixels++
    }
    expect(purplePixels).toBeGreaterThan(500)
    expect(yellowPixels).toBeGreaterThan(500)
  })

  test("stages the same master for macOS, Linux, and Windows packaging", () => {
    generateAppIcons("stable")
    expect(readFileSync(join(DESKTOP_DIR, "build", "icon.png"))).toEqual(
      readFileSync(join(ICONS_DIR, "icon.png")),
    )
    if (process.platform === "darwin") {
      expect(
        readFileSync(join(DESKTOP_DIR, "build", "icon.icns"))
          .subarray(0, 4)
          .toString(),
      ).toBe("icns")
    }

    const builderConfig = readFileSync(join(DESKTOP_DIR, "electron-builder.config.cjs"), "utf8")
    expect(builderConfig.match(/icon: "build\/icon\.icns"/g)).toHaveLength(1)
    expect(builderConfig.match(/icon: "build\/icon\.png"/g)).toHaveLength(2)
    expect(builderConfig).toContain('identity: SIGN ? undefined : "-"')
  })

  test("stages a white Joyplot on viridis for Alpha and magma for Beta", () => {
    for (const channel of ["alpha", "beta"] as const) {
      const source = join(ICONS_DIR, `icon-${channel}.png`)
      const vector = join(ICONS_DIR, `icon-${channel}.svg`)
      expect(existsSync(vector)).toBe(true)
      expect(existsSync(source)).toBe(true)
      generateAppIcons(channel)
      expect(readFileSync(join(DESKTOP_DIR, "build", "icon.png"))).toEqual(readFileSync(source))
      const icon = decodeRgbaPng(source)
      expect([icon.width, icon.height]).toEqual([1024, 1024])
      expect(pixelAt(icon.pixels, icon.width, 0, 0)).toEqual([0, 0, 0, 0])
      expect(pixelAt(icon.pixels, icon.width, 512, 512)).toEqual([255, 255, 255, 255])
      expect(pixelAt(icon.pixels, icon.width, 512, 100)).not.toEqual([255, 255, 255, 255])
    }
    expect(readFileSync(join(ICONS_DIR, "icon-alpha.png"))).not.toEqual(
      readFileSync(join(ICONS_DIR, "icon-beta.png")),
    )
  })
})
