import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import { decodeRgbaPng, type RgbaPng } from "../../../scripts/generate-app-icon"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..")
const EXPLORATIONS_DIR = join(REPO_ROOT, "icons-temp")

const EXPECTED_FILES = [
  "01-baskerville-regular.png",
  "02-didot-bold.png",
  "03-times-new-roman-regular.png",
  "04-georgia-regular.png",
  "05-palatino-regular.png",
  "06-stix-two-text-regular.png",
  "07-avenir-next-medium.png",
  "08-futura-medium.png",
  "09-helvetica-neue-medium.png",
  "10-gill-sans-regular.png",
  "11-rockwell-regular.png",
  "12-copperplate-regular.png",
] as const

function channelAt(png: RgbaPng, x: number, y: number, channel: number): number {
  const value = png.pixels[(y * png.width + x) * 4 + channel]
  if (value === undefined) throw new Error(`pixel channel out of bounds at ${x},${y}`)
  return value
}

function pixelAt(png: RgbaPng, x: number, y: number): [number, number, number, number] {
  return [
    channelAt(png, x, y, 0),
    channelAt(png, x, y, 1),
    channelAt(png, x, y, 2),
    channelAt(png, x, y, 3),
  ]
}

function alphaChannel(png: RgbaPng): Uint8Array {
  const alpha = new Uint8Array(png.width * png.height)
  for (let pixel = 0; pixel < alpha.length; pixel += 1) {
    const value = png.pixels[pixel * 4 + 3]
    if (value === undefined) throw new Error(`alpha channel is missing pixel ${pixel}`)
    alpha[pixel] = value
  }
  return alpha
}

function blackBounds(png: RgbaPng): { left: number; right: number; top: number; bottom: number } {
  let left = png.width
  let right = -1
  let top = png.height
  let bottom = -1
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const red = channelAt(png, x, y, 0)
      const green = channelAt(png, x, y, 1)
      const blue = channelAt(png, x, y, 2)
      const alpha = channelAt(png, x, y, 3)
      if (red < 32 && green < 32 && blue < 32 && alpha > 223) {
        left = Math.min(left, x)
        right = Math.max(right, x)
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
      }
    }
  }
  if (right < left || bottom < top) throw new Error("exploration contains no black Pi glyph")
  return { left, right, top, bottom }
}

describe("unshipped Pi tile font explorations", () => {
  test("contains exactly the 12 indexed 1024px PNG explorations", () => {
    const pngFiles = readdirSync(EXPLORATIONS_DIR)
      .filter((file) => file.endsWith(".png"))
      .sort()
    expect(pngFiles).toEqual(EXPECTED_FILES)

    for (const file of pngFiles) {
      const png = decodeRgbaPng(join(EXPLORATIONS_DIR, file))
      expect([png.width, png.height]).toEqual([1024, 1024])
    }
  })

  test("keeps one white rounded tile and transparent corners behind every font", () => {
    const icons = EXPECTED_FILES.map((file) => decodeRgbaPng(join(EXPLORATIONS_DIR, file)))
    const first = icons[0]
    if (!first) throw new Error("the exploration set is empty")
    const firstAlpha = alphaChannel(first)

    for (const icon of icons) {
      expect(pixelAt(icon, 0, 0)).toEqual([0, 0, 0, 0])
      expect(pixelAt(icon, 1023, 1023)).toEqual([0, 0, 0, 0])
      expect(pixelAt(icon, 512, 100)).toEqual([255, 255, 255, 255])
      expect(Buffer.compare(Buffer.from(alphaChannel(icon)), Buffer.from(firstAlpha))).toBe(0)
    }
  })

  test("centers a distinct black uppercase Pi from each indexed font", () => {
    const fileBodies = new Set<string>()
    for (const file of EXPECTED_FILES) {
      const path = join(EXPLORATIONS_DIR, file)
      const png = decodeRgbaPng(path)
      const bounds = blackBounds(png)
      expect(Math.abs((bounds.left + bounds.right) / 2 - 511.5)).toBeLessThanOrEqual(2)
      expect(Math.abs((bounds.top + bounds.bottom) / 2 - 511.5)).toBeLessThanOrEqual(2)
      fileBodies.add(readFileSync(path).toString("base64"))
    }
    expect(fileBodies.size).toBe(12)

    const readme = readFileSync(join(EXPLORATIONS_DIR, "README.md"), "utf8")
    for (const file of EXPECTED_FILES) expect(readme).toContain(file)
  })
})
