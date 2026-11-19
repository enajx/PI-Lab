import { readFile } from "node:fs/promises"
import { encode as encodeJpeg } from "jpeg-js"
import { PNG } from "pngjs"
import { describe, expect, test } from "vitest"
import { nodeThumbnailImageProcessor } from "./nodeThumbnailImage"

/** Solid red RGBA pixels. */
function solid(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i)
  return data
}

/** Decode a badge data URL and fail if it is not a valid PNG. */
function badgePng(dataUrl: string): PNG {
  expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true)
  return PNG.sync.read(Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64"))
}

describe("node thumbnail processor (real bytes, no Electron)", () => {
  test("PNG: reports size and shrinks the badge to 64 px", () => {
    const png = new PNG({ width: 200, height: 100 })
    solid(200, 100).copy(png.data)
    const result = nodeThumbnailImageProcessor.inspect(PNG.sync.write(png))
    expect(result).toMatchObject({ width: 200, height: 100 })
    const badge = badgePng(result?.badgeDataUrl as string)
    expect([badge.width, badge.height]).toEqual([64, 32])
    expect(Array.from(badge.data.subarray(0, 4))).toEqual([255, 0, 0, 255])
  })

  test("PNG: small image keeps its size", () => {
    const png = new PNG({ width: 10, height: 6 })
    solid(10, 6).copy(png.data)
    const result = nodeThumbnailImageProcessor.inspect(PNG.sync.write(png))
    const badge = badgePng(result?.badgeDataUrl as string)
    expect([badge.width, badge.height]).toEqual([10, 6])
  })

  test("JPEG: reports size and a valid PNG badge", () => {
    const jpeg = encodeJpeg({ width: 128, height: 64, data: solid(128, 64) }, 90).data
    const result = nodeThumbnailImageProcessor.inspect(jpeg)
    expect(result).toMatchObject({ width: 128, height: 64 })
    const badge = badgePng(result?.badgeDataUrl as string)
    expect([badge.width, badge.height]).toEqual([64, 32])
    expect(badge.data[0]).toBeGreaterThan(200)
  })

  test("GIF: decodes the first frame of the fixture", async () => {
    const gif = await readFile(
      new URL("../../../../../../tests/e2e/fixtures/media/tiny.gif", import.meta.url),
    )
    const result = nodeThumbnailImageProcessor.inspect(gif)
    expect(result?.width).toBe(gif.readUInt16LE(6))
    expect(result?.height).toBe(gif.readUInt16LE(8))
    badgePng(result?.badgeDataUrl as string)
  })

  test("WebP: decodes a lossless image to a valid PNG badge", async () => {
    const wasm = await readFile(require.resolve("@jsquash/webp/codec/enc/webp_enc.wasm"))
    const encoder = await import("@jsquash/webp/encode.js")
    await (encoder.init as (module: undefined, options: unknown) => Promise<unknown>)(undefined, {
      wasmBinary: Uint8Array.from(wasm).buffer,
    })
    const pixels = new Uint8ClampedArray(solid(100, 50))
    const webp = Buffer.from(
      await encoder.default(
        { width: 100, height: 50, data: pixels, colorSpace: "srgb" } as unknown as Parameters<
          typeof encoder.default
        >[0],
        { lossless: 1 },
      ),
    )
    const result = await nodeThumbnailImageProcessor.inspectWebP(webp)
    expect(result).toMatchObject({ width: 100, height: 50 })
    const badge = badgePng(result?.badgeDataUrl as string)
    expect([badge.width, badge.height]).toEqual([64, 32])
    expect(Array.from(badge.data.subarray(0, 4))).toEqual([255, 0, 0, 255])
  })

  test("rejects garbage and huge JPEG headers", async () => {
    expect(nodeThumbnailImageProcessor.inspect(Buffer.alloc(40, 1))).toBeNull()
    expect(await nodeThumbnailImageProcessor.inspectWebP(Buffer.alloc(40, 1))).toBeNull()
    const huge = Buffer.alloc(25)
    huge.set([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 7, 8])
    huge.writeUInt16BE(16_384, 13)
    huge.writeUInt16BE(16_384, 15)
    expect(nodeThumbnailImageProcessor.inspect(huge)).toBeNull()
  })
})
