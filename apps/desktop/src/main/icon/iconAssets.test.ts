import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  decodeRgbaPng,
  generateAppIcons,
  validateIconSources,
} from "../../../scripts/generate-app-icon"
import { APP_ICON_PALETTES } from "../../shared/appIcon"

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = resolve(HERE, "..", "..", "..")
const REPO_ROOT = resolve(DESKTOP_DIR, "..", "..")
const ICONS_DIR = join(DESKTOP_DIR, "assets", "icons")
const outputs: string[] = []
const guard = vi.hoisted(() => ({ sharedBuild: "" }))
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    cpSync: (...args: Parameters<typeof actual.cpSync>) => {
      if (String(args[1]).startsWith(guard.sharedBuild)) {
        throw new Error("Icon tests must not write shared packaging inputs")
      }
      return actual.cpSync(...args)
    },
  }
})
guard.sharedBuild = join(DESKTOP_DIR, "build")

function temporaryOutput(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-lab-icon-test-"))
  outputs.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of outputs.splice(0)) rmSync(directory, { recursive: true, force: true })
})
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
      readFileSync(join(ICONS_DIR, "matplotlib-colormaps-3.11.2.json"), "utf8"),
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
    ).toEqual(
      APP_ICON_PALETTES.filter((name) => !name.startsWith("gray-") && name !== "black").sort(),
    )
    expect(data.palettes.viridis?.[0]).toBe("#440154")
    expect(data.palettes.viridis?.at(-1)).toBe("#fde725")
    for (const colors of Object.values(data.palettes)) expect(colors).toHaveLength(256)
  })

  test("excludes retired branding while preserving the canonical icon", () => {
    for (const legacyPath of LEGACY_ICON_PATHS) {
      expect(existsSync(join(ICONS_DIR, legacyPath)), `${legacyPath} should be removed`).toBe(false)
    }

    for (const retainedPath of ["icon.png", "icon.svg", "icon.manifest.json"]) {
      expect(existsSync(join(ICONS_DIR, retainedPath)), `${retainedPath} should be retained`).toBe(
        true,
      )
    }
  })

  test("pins the larger Gill Sans Pi #303030 vector and its committed PNG derivative", () => {
    const manifest = validateIconSources()
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      master: { path: "apps/desktop/assets/icons/icon.svg" },
      derivative: { path: "apps/desktop/assets/icons/icon.png", width: 1024, height: 1024 },
    })
    expect(sha256(join(REPO_ROOT, manifest.master.path))).toBe(manifest.master.sha256)
    expect(sha256(join(REPO_ROOT, manifest.derivative.path))).toBe(manifest.derivative.sha256)

    const svg = readFileSync(join(ICONS_DIR, "icon.svg"), "utf8")
    expect(svg).toContain("Gill Sans Regular Pi, solid #303030, white background")
    expect(svg).toContain('fill="#303030"')
    expect(svg).toContain("<path")
    expect(svg).not.toMatch(/<(?:text|image)\b/)
  })

  test("uses the chosen Pi raster on a light tile with transparent corners", () => {
    const icon = decodeRgbaPng(join(ICONS_DIR, "icon.png"))
    expect([icon.width, icon.height]).toEqual([1024, 1024])
    expect(pixelAt(icon.pixels, icon.width, 0, 0)).toEqual([0, 0, 0, 0])
    expect(pixelAt(icon.pixels, icon.width, 1023, 1023)).toEqual([0, 0, 0, 0])
    expect(pixelAt(icon.pixels, icon.width, 512, 100)).toEqual([255, 255, 255, 255])
    expect(pixelAt(icon.pixels, icon.width, 512, 270)).toEqual([48, 48, 48, 255])
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
    const output = temporaryOutput()
    generateAppIcons("stable", output)
    expect(readFileSync(join(output, "icon.png"))).toEqual(
      readFileSync(join(ICONS_DIR, "icon.png")),
    )
    if (process.platform === "darwin") {
      expect(readFileSync(join(output, "icon.icns")).subarray(0, 4).toString()).toBe("icns")
    }

    const builderConfig = readFileSync(join(DESKTOP_DIR, "electron-builder.config.cjs"), "utf8")
    expect(builderConfig.match(/icon: "build\/icon\.icns"/g)).toHaveLength(1)
    expect(builderConfig.match(/icon: "build\/icon\.png"/g)).toHaveLength(2)
    expect(builderConfig).toContain('identity: SIGN ? undefined : "-"')
  })

  test("stages the viridis Pi on white for Alpha and white Pi on gray for Beta", () => {
    const output = temporaryOutput()
    for (const channel of ["alpha", "beta"] as const) {
      const source = join(ICONS_DIR, `icon-${channel}.png`)
      const vector = join(ICONS_DIR, `icon-${channel}.svg`)
      expect(existsSync(vector)).toBe(true)
      expect(existsSync(source)).toBe(true)
      generateAppIcons(channel, output)
      expect(readFileSync(join(output, "icon.png"))).toEqual(readFileSync(source))
      const icon = decodeRgbaPng(source)
      expect([icon.width, icon.height]).toEqual([1024, 1024])
      expect(pixelAt(icon.pixels, icon.width, 0, 0)).toEqual([0, 0, 0, 0])
      const symbolPixel: [number, number] = [512, 270]
      const symbol = pixelAt(icon.pixels, icon.width, symbolPixel[0], symbolPixel[1])
      if (channel === "alpha") {
        expect(symbol).not.toEqual([255, 255, 255, 255])
        expect(pixelAt(icon.pixels, icon.width, 512, 100)).toEqual([255, 255, 255, 255])
      } else {
        expect(symbol).toEqual([255, 255, 255, 255])
        expect(pixelAt(icon.pixels, icon.width, 512, 100)).toEqual([48, 48, 48, 255])
      }
    }
    expect(readFileSync(join(ICONS_DIR, "icon-alpha.png"))).not.toEqual(
      readFileSync(join(ICONS_DIR, "icon-beta.png")),
    )
  })
})
