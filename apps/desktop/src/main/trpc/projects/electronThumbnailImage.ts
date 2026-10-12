import { readFile } from "node:fs/promises"
import { nativeImage } from "electron"
import { GifReader } from "omggif"
import { jpegDimensions } from "./jpegDimensions"
import type { ThumbnailImageProcessor } from "./thumbnailImage"
import { firstWebPFrame } from "./webpFirstFrame"

const MAX_PIXELS = 16_000_000
let webpDecoder: Promise<typeof import("@jsquash/webp/decode.js")> | null = null

/** Load the 138 KB decoder WASM from the installed package only for old WebP rows. */
function loadWebPDecoder(): Promise<typeof import("@jsquash/webp/decode.js")> {
  if (!webpDecoder) {
    webpDecoder = (async () => {
      const decoder = await import("@jsquash/webp/decode.js")
      const wasm = await readFile(require.resolve("@jsquash/webp/codec/dec/webp_dec.wasm"))
      await decoder.init({ wasmBinary: Uint8Array.from(wasm).buffer })
      return decoder
    })()
  }
  return webpDecoder
}

/** Encode a decoded image as a bounded static badge. */
function badgeFromImage(image: Electron.NativeImage) {
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  if (width < 1 || height < 1 || width * height > MAX_PIXELS) return null
  const edge = Math.max(width, height)
  const badge =
    edge > 64
      ? image.resize({
          width: Math.max(1, Math.round((width * 64) / edge)),
          height: Math.max(1, Math.round((height * 64) / edge)),
        })
      : image
  return {
    width,
    height,
    badgeDataUrl: `data:image/png;base64,${badge.toPNG().toString("base64")}`,
  }
}

/** Decode the first GIF frame without allocating or decoding later frames. */
function firstGifFrame(bytes: Buffer) {
  const width = bytes.readUInt16LE(6)
  const height = bytes.readUInt16LE(8)
  if (width < 1 || height < 1 || width * height > MAX_PIXELS) return null
  const reader = new GifReader(bytes)
  if (reader.numFrames() < 1 || reader.width !== width || reader.height !== height) return null
  const frame = reader.frameInfo(0)
  if (
    frame.width < 1 ||
    frame.height < 1 ||
    frame.width * frame.height > MAX_PIXELS ||
    frame.x < 0 ||
    frame.y < 0 ||
    frame.x + frame.width > width ||
    frame.y + frame.height > height
  )
    return null
  const pixels = Buffer.alloc(width * height * 4)
  reader.decodeAndBlitFrameBGRA(0, pixels)
  return nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 1 })
}

/** Electron image decoder used by the projects router through its context port. */
export const electronThumbnailImageProcessor: ThumbnailImageProcessor = {
  inspect(bytes) {
    if (bytes.length < 24) return null
    const gif = bytes.toString("ascii", 0, 3) === "GIF"
    if (gif) {
      const width = bytes.readUInt16LE(6)
      const height = bytes.readUInt16LE(8)
      if (width < 1 || height < 1 || width * height > MAX_PIXELS) return null
    } else if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
      const width = bytes.readUInt32BE(16)
      const height = bytes.readUInt32BE(20)
      if (width < 1 || height < 1 || width * height > MAX_PIXELS) return null
    } else {
      const dimensions = jpegDimensions(bytes)
      if (!dimensions || dimensions.width * dimensions.height > MAX_PIXELS) return null
    }
    // Both decoders receive untrusted local files. A malformed image is a
    // visible rejected upload or stored-image fallback, not a main-process crash.
    try {
      const image = gif ? firstGifFrame(bytes) : nativeImage.createFromBuffer(bytes)
      return image ? badgeFromImage(image) : null
    } catch {
      return null
    }
  },
  async inspectWebP(bytes) {
    const frame = firstWebPFrame(bytes)
    if (!frame) return null
    // The RIFF frame and canvas bounds are checked before libwebp allocates.
    try {
      const { default: decode } = await loadWebPDecoder()
      const data = frame.bytes.buffer.slice(
        frame.bytes.byteOffset,
        frame.bytes.byteOffset + frame.bytes.byteLength,
      ) as ArrayBuffer
      const decoded = await decode(data)
      if (decoded.width !== frame.frameWidth || decoded.height !== frame.frameHeight) return null
      const pixels = Buffer.alloc(frame.canvasWidth * frame.canvasHeight * 4)
      const [bgBlue, bgGreen, bgRed, bgAlpha] = frame.background
      for (let pixel = 0; pixel < pixels.length; pixel += 4) {
        pixels[pixel] = bgBlue
        pixels[pixel + 1] = bgGreen
        pixels[pixel + 2] = bgRed
        pixels[pixel + 3] = bgAlpha
      }
      for (let y = 0; y < frame.frameHeight; y += 1) {
        for (let x = 0; x < frame.frameWidth; x += 1) {
          const source = (y * frame.frameWidth + x) * 4
          const destination = ((y + frame.y) * frame.canvasWidth + x + frame.x) * 4
          const sourceAlpha = decoded.data[source + 3] as number
          const targetAlpha = frame.replace ? 0 : (pixels[destination + 3] as number)
          const outputAlpha = sourceAlpha + (targetAlpha * (255 - sourceAlpha)) / 255
          for (let channel = 0; channel < 3; channel += 1) {
            const sourceChannel = decoded.data[source + 2 - channel] as number
            const targetChannel = pixels[destination + channel] as number
            pixels[destination + channel] = outputAlpha
              ? Math.round(
                  (sourceChannel * sourceAlpha +
                    (targetChannel * targetAlpha * (255 - sourceAlpha)) / 255) /
                    outputAlpha,
                )
              : 0
          }
          pixels[destination + 3] = Math.round(outputAlpha)
        }
      }
      // Electron's bitmap input is premultiplied BGRA. Keep the blend math in
      // straight color above, then multiply once before crossing that boundary.
      for (let pixel = 0; pixel < pixels.length; pixel += 4) {
        const alpha = pixels[pixel + 3] as number
        for (let channel = 0; channel < 3; channel += 1) {
          pixels[pixel + channel] = Math.round(((pixels[pixel + channel] as number) * alpha) / 255)
        }
      }
      return badgeFromImage(
        nativeImage.createFromBitmap(pixels, {
          width: frame.canvasWidth,
          height: frame.canvasHeight,
          scaleFactor: 1,
        }),
      )
    } catch {
      return null
    }
  },
}
