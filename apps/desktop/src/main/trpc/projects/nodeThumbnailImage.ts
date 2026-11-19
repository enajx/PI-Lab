import { readFile } from "node:fs/promises"
import { decode as decodeJpeg } from "jpeg-js"
import { GifReader } from "omggif"
import { PNG } from "pngjs"
import { jpegDimensions } from "./jpegDimensions"
import type { ThumbnailImageProcessor } from "./thumbnailImage"
import { firstWebPFrame } from "./webpFirstFrame"

const MAX_PIXELS = 16_000_000
const BADGE_EDGE = 64
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex")

/** Straight (non-premultiplied) RGBA pixels. */
interface RgbaImage {
  width: number
  height: number
  data: Buffer
}

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

/** Shrink with an alpha-weighted box average so the badge keeps its edges soft. */
function resizeBox(image: RgbaImage, width: number, height: number): RgbaImage {
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor((y * image.height) / height)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / height))
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor((x * image.width) / width)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / width))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * image.width + sx) * 4
          const alpha = image.data[i + 3] as number
          r += (image.data[i] as number) * alpha
          g += (image.data[i + 1] as number) * alpha
          b += (image.data[i + 2] as number) * alpha
          a += alpha
        }
      }
      const count = (y1 - y0) * (x1 - x0)
      const o = (y * width + x) * 4
      out[o] = a ? Math.round(r / a) : 0
      out[o + 1] = a ? Math.round(g / a) : 0
      out[o + 2] = a ? Math.round(b / a) : 0
      out[o + 3] = Math.round(a / count)
    }
  }
  return { width, height, data: out }
}

/** Encode a decoded image as a bounded static PNG badge. */
function badgeFromImage(image: RgbaImage) {
  const { width, height } = image
  if (width < 1 || height < 1 || width * height > MAX_PIXELS) return null
  const edge = Math.max(width, height)
  const badge =
    edge > BADGE_EDGE
      ? resizeBox(
          image,
          Math.max(1, Math.round((width * BADGE_EDGE) / edge)),
          Math.max(1, Math.round((height * BADGE_EDGE) / edge)),
        )
      : image
  const png = new PNG({ width: badge.width, height: badge.height })
  badge.data.copy(png.data)
  return {
    width,
    height,
    badgeDataUrl: `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`,
  }
}

/** Decode the first GIF frame without allocating or decoding later frames. */
function firstGifFrame(bytes: Buffer): RgbaImage | null {
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
  reader.decodeAndBlitFrameRGBA(0, pixels)
  return { width, height, data: pixels }
}

/** Composite the first WebP frame onto its canvas and background. */
async function webpImage(bytes: Buffer): Promise<RgbaImage | null> {
  const frame = firstWebPFrame(bytes)
  if (!frame) return null
  // The RIFF frame and canvas bounds are checked before libwebp allocates.
  const { default: decode } = await loadWebPDecoder()
  const data = frame.bytes.buffer.slice(
    frame.bytes.byteOffset,
    frame.bytes.byteOffset + frame.bytes.byteLength,
  ) as ArrayBuffer
  const decoded = await decode(data)
  if (decoded.width !== frame.frameWidth || decoded.height !== frame.frameHeight) return null
  const pixels = Buffer.alloc(frame.canvasWidth * frame.canvasHeight * 4)
  // frame.background is ordered blue, green, red, alpha.
  const [bgBlue, bgGreen, bgRed, bgAlpha] = frame.background
  for (let pixel = 0; pixel < pixels.length; pixel += 4) {
    pixels[pixel] = bgRed
    pixels[pixel + 1] = bgGreen
    pixels[pixel + 2] = bgBlue
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
        const sourceChannel = decoded.data[source + channel] as number
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
  return { width: frame.canvasWidth, height: frame.canvasHeight, data: pixels }
}

/** Pure JS image decoder used by the projects router through its context port. */
export const nodeThumbnailImageProcessor: ThumbnailImageProcessor = {
  inspect(bytes) {
    if (bytes.length < 24) return null
    const gif = bytes.toString("ascii", 0, 3) === "GIF"
    const png = bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    if (gif) {
      const width = bytes.readUInt16LE(6)
      const height = bytes.readUInt16LE(8)
      if (width < 1 || height < 1 || width * height > MAX_PIXELS) return null
    } else if (png) {
      const width = bytes.readUInt32BE(16)
      const height = bytes.readUInt32BE(20)
      if (width < 1 || height < 1 || width * height > MAX_PIXELS) return null
    } else {
      const dimensions = jpegDimensions(bytes)
      if (!dimensions || dimensions.width * dimensions.height > MAX_PIXELS) return null
    }
    // The decoders receive untrusted local files. A malformed image is a
    // visible rejected upload or stored-image fallback, not a process crash.
    try {
      let image: RgbaImage | null
      if (gif) image = firstGifFrame(bytes)
      else if (png) {
        const decoded = PNG.sync.read(bytes)
        image = { width: decoded.width, height: decoded.height, data: decoded.data }
      } else {
        const decoded = decodeJpeg(bytes, { useTArray: true, maxMemoryUsageInMB: 512 })
        image = { width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) }
      }
      return image ? badgeFromImage(image) : null
    } catch {
      return null
    }
  },
  async inspectWebP(bytes) {
    try {
      const image = await webpImage(bytes)
      return image ? badgeFromImage(image) : null
    } catch {
      return null
    }
  },
}
