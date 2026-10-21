#!/usr/bin/env bun
/**
 * Validate and stage the canonical PI Lab icon for electron-builder.
 *
 * `icons/icon.svg` is the vector master for joyplot style 25 in magma, expanded.
 * `icons/icon.png` is its committed 1024×1024 derivative, so packaging never
 * needs an SVG renderer. `icons/icon.manifest.json` pins both files together.
 *
 * Outputs:
 *   - `build/icon.png` — Linux source and Windows `.ico` source.
 *   - `build/icon.icns` — macOS icon set, derived with native macOS tools.
 */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { inflateSync } from "node:zlib"
import type { PiLabChannel } from "../src/main/identity/channel"

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = resolve(HERE, "..")
const REPO_ROOT = resolve(DESKTOP_DIR, "..", "..")
const ICONS_DIR = join(REPO_ROOT, "icons")
const MASTER = join(ICONS_DIR, "icon.svg")
const SOURCE = join(ICONS_DIR, "icon.png")
const MANIFEST = join(ICONS_DIR, "icon.manifest.json")
const BUILD_DIR = join(DESKTOP_DIR, "build")

interface IconManifest {
  schemaVersion: number
  master: {
    path: string
    sha256: string
  }
  derivative: {
    path: string
    sha256: string
    width: number
    height: number
  }
  channelVariants: Record<"alpha" | "beta", { master: string; derivative: string }>
}

export interface RgbaPng {
  width: number
  height: number
  pixels: Uint8Array
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function paeth(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft
  const leftDistance = Math.abs(prediction - left)
  const aboveDistance = Math.abs(prediction - above)
  const upperLeftDistance = Math.abs(prediction - upperLeft)
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left
  if (aboveDistance <= upperLeftDistance) return above
  return upperLeft
}

function byteAt(bytes: Uint8Array, index: number): number {
  const value = bytes[index]
  if (value === undefined) throw new Error(`decoded PNG byte ${index} is out of bounds`)
  return value
}

/** Decode the deliberately constrained canonical RGBA PNG without image dependencies. */
export function decodeRgbaPng(path: string): RgbaPng {
  const png = readFileSync(path)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!png.subarray(0, signature.length).equals(signature)) {
    throw new Error(`icon is not a PNG: ${path}`)
  }

  let offset = signature.length
  let width = 0
  let height = 0
  const compressedRows: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString("ascii", offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const [bitDepth, colorType, compression, filter, interlace] = data.subarray(8, 13)
      if (
        bitDepth !== 8 ||
        colorType !== 6 ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        throw new Error("canonical icon.png must be a non-interlaced 8-bit RGBA PNG")
      }
    }
    if (type === "IDAT") compressedRows.push(data)
    offset += length + 12
    if (type === "IEND") break
  }

  if (width === 0 || height === 0 || compressedRows.length === 0) {
    throw new Error("canonical icon.png is missing required PNG chunks")
  }

  const packed = inflateSync(Buffer.concat(compressedRows))
  const bytesPerPixel = 4
  const rowBytes = width * bytesPerPixel
  if (packed.length !== (rowBytes + 1) * height) {
    throw new Error("canonical icon.png has an unexpected decoded byte length")
  }

  const pixels = new Uint8Array(rowBytes * height)
  for (let y = 0; y < height; y += 1) {
    const sourceRow = y * (rowBytes + 1)
    const filter = byteAt(packed, sourceRow)
    for (let x = 0; x < rowBytes; x += 1) {
      const encoded = byteAt(packed, sourceRow + x + 1)
      const target = y * rowBytes + x
      const left = x >= bytesPerPixel ? byteAt(pixels, target - bytesPerPixel) : 0
      const above = y > 0 ? byteAt(pixels, target - rowBytes) : 0
      const upperLeft =
        y > 0 && x >= bytesPerPixel ? byteAt(pixels, target - rowBytes - bytesPerPixel) : 0
      if (filter === 0) pixels[target] = encoded
      else if (filter === 1) pixels[target] = (encoded + left) & 0xff
      else if (filter === 2) pixels[target] = (encoded + above) & 0xff
      else if (filter === 3) pixels[target] = (encoded + Math.floor((left + above) / 2)) & 0xff
      else if (filter === 4) pixels[target] = (encoded + paeth(left, above, upperLeft)) & 0xff
      else throw new Error(`canonical icon.png uses unsupported PNG filter ${filter}`)
    }
  }
  return { width, height, pixels }
}

function pixelAt(png: RgbaPng, x: number, y: number): [number, number, number, number] {
  const offset = (y * png.width + x) * 4
  return [
    byteAt(png.pixels, offset),
    byteAt(png.pixels, offset + 1),
    byteAt(png.pixels, offset + 2),
    byteAt(png.pixels, offset + 3),
  ]
}

function assertPixel(
  png: RgbaPng,
  x: number,
  y: number,
  expected: [number, number, number, number],
  label: string,
): void {
  const actual = pixelAt(png, x, y)
  if (!actual.every((channel, index) => channel === expected[index])) {
    throw new Error(`${label} pixel must be ${expected.join(",")}; got ${actual.join(",")}`)
  }
}

/** Validate provenance, geometry, transparent corners, light tile, and joyplot fill. */
export function validateIconSources(): IconManifest {
  for (const path of [MASTER, SOURCE, MANIFEST]) {
    if (!existsSync(path)) throw new Error(`canonical icon source not found at ${path}`)
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as IconManifest
  if (
    manifest.schemaVersion !== 1 ||
    manifest.master.path !== "icons/icon.svg" ||
    manifest.derivative.path !== "icons/icon.png"
  ) {
    throw new Error("icon.manifest.json does not describe the canonical icon.svg/icon.png pair")
  }
  if (sha256(MASTER) !== manifest.master.sha256) {
    throw new Error("icon.svg does not match its provenance manifest")
  }
  if (sha256(SOURCE) !== manifest.derivative.sha256) {
    throw new Error("icon.png is stale or does not match icon.svg's derivative manifest")
  }

  const svg = readFileSync(MASTER, "utf8")
  if (
    !svg.includes('viewBox="0 0 1024 1024"') ||
    !svg.includes('x="64" y="64" width="896" height="896" rx="210" fill="#fff"') ||
    !svg.includes("joyplot icon: style 25, ascending peaks, magma, expanded") ||
    !svg.includes('stop-color="#000004"') ||
    !svg.includes('id="expanded-tile"') ||
    !svg.includes('stroke="#fff"') ||
    !svg.includes("<path") ||
    /<(?:text|image)\b/.test(svg)
  ) {
    throw new Error("icon.svg must contain expanded joyplot style 25 in magma on the white tile")
  }

  const png = decodeRgbaPng(SOURCE)
  if (png.width !== manifest.derivative.width || png.height !== manifest.derivative.height) {
    throw new Error(
      `icon.png must be ${manifest.derivative.width}×${manifest.derivative.height}; got ${png.width}×${png.height}`,
    )
  }
  const corners: Array<[number, number]> = [
    [0, 0],
    [png.width - 1, 0],
    [0, png.height - 1],
    [png.width - 1, png.height - 1],
  ]
  for (const [x, y] of corners) {
    assertPixel(png, x, y, [0, 0, 0, 0], "outer corner")
  }
  assertPixel(png, 512, 100, [255, 255, 255, 255], "white tile")
  assertPixel(png, 512, 512, [182, 58, 116, 255], "magma plot")
  for (const channel of ["alpha", "beta"] as const) {
    const variant = manifest.channelVariants?.[channel]
    const vector = join(ICONS_DIR, `icon-${channel}.svg`)
    const raster = join(ICONS_DIR, `icon-${channel}.png`)
    if (!variant || !existsSync(vector) || !existsSync(raster)) {
      throw new Error(`${channel} icon source is missing`)
    }
    if (sha256(vector) !== variant.master || sha256(raster) !== variant.derivative) {
      throw new Error(`${channel} icon does not match its provenance manifest`)
    }
    const svg = readFileSync(vector, "utf8")
    const palette = channel === "alpha" ? "viridis" : "magma"
    if (
      !svg.includes(`ascending peaks, ${palette} inverted, expanded`) ||
      !svg.includes('fill="url(#fill)" />') ||
      (svg.match(/fill="#fff"/g) ?? []).length !== 3
    ) {
      throw new Error(`${channel} icon must have a ${palette} tile and white Joyplot`)
    }
    const icon = decodeRgbaPng(raster)
    if (icon.width !== 1024 || icon.height !== 1024) {
      throw new Error(`${channel} icon must be 1024×1024`)
    }
    assertPixel(icon, 0, 0, [0, 0, 0, 0], `${channel} outer corner`)
    assertPixel(icon, 512, 512, [255, 255, 255, 255], `${channel} Joyplot`)
  }
  return manifest
}

function sips(args: string[]): void {
  execFileSync("sips", args, { stdio: "ignore" })
}

/** Build `build/icon.icns` from the 1024px master via sips + the ICNS container format. */
function buildIcns(masterPng: string, outputDirectory: string): void {
  const container = mkdtempSync(join(tmpdir(), "pi-lab-iconset-"))
  const iconset = join(container, "icon.iconset")
  mkdirSync(iconset)
  const variants: Array<{ size: number; name: string; type: string }> = [
    { size: 16, name: "icon_16x16.png", type: "icp4" },
    { size: 32, name: "icon_16x16@2x.png", type: "ic11" },
    { size: 32, name: "icon_32x32.png", type: "icp5" },
    { size: 64, name: "icon_32x32@2x.png", type: "ic12" },
    { size: 128, name: "icon_128x128.png", type: "ic07" },
    { size: 256, name: "icon_128x128@2x.png", type: "ic13" },
    { size: 256, name: "icon_256x256.png", type: "ic08" },
    { size: 512, name: "icon_256x256@2x.png", type: "ic14" },
    { size: 512, name: "icon_512x512.png", type: "ic09" },
    { size: 1024, name: "icon_512x512@2x.png", type: "ic10" },
  ]
  for (const { size, name } of variants) {
    sips(["-z", String(size), String(size), masterPng, "--out", join(iconset, name)])
  }

  // Modern ICNS resources store each representation as an ordinary PNG payload.
  // Writing the tiny container directly avoids `iconutil` regressions while still
  // producing a file that iconutil, Finder, and electron-builder can consume.
  const chunks = variants.map(({ name, type }) => {
    const png = readFileSync(join(iconset, name))
    const chunk = Buffer.alloc(png.length + 8)
    chunk.write(type, 0, 4, "ascii")
    chunk.writeUInt32BE(chunk.length, 4)
    png.copy(chunk, 8)
    return chunk
  })
  const header = Buffer.alloc(8)
  header.write("icns", 0, 4, "ascii")
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4)
  const output = join(outputDirectory, "icon.icns")
  writeFileSync(output, Buffer.concat([header, ...chunks]))
  rmSync(container, { recursive: true, force: true })
}

export function generateAppIcons(channel: PiLabChannel, outputDirectory: string): void {
  validateIconSources()
  mkdirSync(outputDirectory, { recursive: true })

  const masterPng = join(outputDirectory, "icon.png")
  const source = channel === "stable" ? SOURCE : join(ICONS_DIR, `icon-${channel}.png`)
  cpSync(source, masterPng)
  console.log(`icon.png  → ${masterPng}`)

  if (process.platform === "darwin") {
    buildIcns(masterPng, outputDirectory)
    console.log(`icon.icns → ${join(outputDirectory, "icon.icns")}`)
  } else {
    console.log("non-macOS host: skipping icon.icns (electron-builder derives from icon.png)")
  }
}

if (import.meta.main) {
  const publicReleaseChannel = process.env.PI_LAB_PUBLIC_RELEASE_CHANNEL
  if (
    publicReleaseChannel &&
    publicReleaseChannel !== "stable" &&
    publicReleaseChannel !== "beta"
  ) {
    throw new Error(`Unknown public release icon channel: ${publicReleaseChannel}`)
  }
  const value = publicReleaseChannel ?? process.env.PI_LAB_CHANNEL ?? "stable"
  if (value !== "alpha" && value !== "beta" && value !== "stable") {
    throw new Error(`Unknown PI Lab icon channel: ${value}`)
  }
  generateAppIcons(value, BUILD_DIR)
}
