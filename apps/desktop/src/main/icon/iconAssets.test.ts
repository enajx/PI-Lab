import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import {
  decodeRgbaPng,
  generateAppIcons,
  validateIconSources,
} from "../../../scripts/generate-app-icon"

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = resolve(HERE, "..", "..", "..")
const REPO_ROOT = resolve(DESKTOP_DIR, "..", "..")
const ICONS_DIR = join(REPO_ROOT, "icons")

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

function blackPixelBounds(icon: ReturnType<typeof decodeRgbaPng>): {
  left: number
  top: number
  right: number
  bottom: number
} {
  let left = icon.width
  let top = icon.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < icon.height; y += 1) {
    for (let x = 0; x < icon.width; x += 1) {
      const [red, green, blue, alpha] = pixelAt(icon.pixels, icon.width, x, y)
      if (red >= 64 || green >= 64 || blue >= 64 || alpha <= 128) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < left || bottom < top) throw new Error("canonical icon contains no black Pi glyph")
  return { left, top, right, bottom }
}

describe("canonical PI Lab application icon", () => {
  test("pins the outlined Avenir Next Medium vector and its committed PNG derivative", () => {
    const manifest = validateIconSources()
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      master: { path: "icons/icon.svg" },
      derivative: { path: "icons/icon.png", width: 1024, height: 1024 },
    })
    expect(sha256(join(REPO_ROOT, manifest.master.path))).toBe(manifest.master.sha256)
    expect(sha256(join(REPO_ROOT, manifest.derivative.path))).toBe(manifest.derivative.sha256)

    const svg = readFileSync(join(ICONS_DIR, "icon.svg"), "utf8")
    expect(svg).toContain("Avenir Next Medium")
    expect(svg).toContain("face index 5")
    expect(svg).toContain("436.638×580")
    expect(svg).not.toContain("Computer Modern")
    expect(svg).toContain("<path")
    expect(svg).not.toMatch(/<(?:text|image)\b/)
    expect(readFileSync(join(ICONS_DIR, "ICON-PROVENANCE.md"), "utf8")).toContain(
      "Avenir Next Medium",
    )
  })

  test("keeps the 1024px raster corners transparent and the tile and Pi opaque", () => {
    const icon = decodeRgbaPng(join(ICONS_DIR, "icon.png"))
    expect([icon.width, icon.height]).toEqual([1024, 1024])
    expect(pixelAt(icon.pixels, icon.width, 0, 0)).toEqual([0, 0, 0, 0])
    expect(pixelAt(icon.pixels, icon.width, 1023, 1023)).toEqual([0, 0, 0, 0])
    expect(pixelAt(icon.pixels, icon.width, 512, 100)).toEqual([255, 255, 255, 255])
    expect(pixelAt(icon.pixels, icon.width, 512, 240)).toEqual([0, 0, 0, 255])
    expect(blackPixelBounds(icon)).toEqual({ left: 294, top: 222, right: 729, bottom: 801 })
  })

  test("stages the same master for macOS, Linux, and Windows packaging", () => {
    generateAppIcons()
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
})
