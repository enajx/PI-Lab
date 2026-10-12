const MAX_PIXELS = 16_000_000

interface WebPFrame {
  canvasWidth: number
  canvasHeight: number
  frameWidth: number
  frameHeight: number
  x: number
  y: number
  background: [number, number, number, number]
  replace: boolean
  bytes: Buffer
}

/** Read an unsigned three-byte integer from a bounded RIFF chunk. */
function uint24(bytes: Buffer, offset: number): number {
  return (
    (bytes[offset] as number) |
    ((bytes[offset + 1] as number) << 8) |
    ((bytes[offset + 2] as number) << 16)
  )
}

/** Avoid image decoder allocations from a small, highly compressed huge image. */
function boundedDimensions(width: number, height: number): boolean {
  return width > 0 && height > 0 && width * height <= MAX_PIXELS
}

/** Read VP8 or VP8L bitstream dimensions even inside a VP8X/ANMF wrapper. */
function imageDimensions(
  bytes: Buffer,
  start: number,
  length: number,
  kind: "VP8 " | "VP8L",
): { width: number; height: number } | null {
  if (kind === "VP8 ") {
    if (length < 10 || bytes.toString("hex", start + 3, start + 6) !== "9d012a") return null
    return {
      width: bytes.readUInt16LE(start + 6) & 0x3fff,
      height: bytes.readUInt16LE(start + 8) & 0x3fff,
    }
  }
  if (length < 5 || bytes[start] !== 0x2f) return null
  return {
    width: 1 + ((bytes[start + 1] as number) | (((bytes[start + 2] as number) & 0x3f) << 8)),
    height:
      1 +
      (((bytes[start + 2] as number) >> 6) |
        ((bytes[start + 3] as number) << 2) |
        (((bytes[start + 4] as number) & 0x0f) << 10)),
  }
}

/** Read the first frame and canvas dimensions without decompressing pixels. */
export function firstWebPFrame(bytes: Buffer): WebPFrame | null {
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  )
    return null
  const end = bytes.readUInt32LE(4) + 8
  if (end > bytes.length || end < 20) return null
  let canvasWidth = 0
  let canvasHeight = 0
  let animated = false
  let background: WebPFrame["background"] = [0, 0, 0, 0]
  for (let offset = 12; offset + 8 <= end; ) {
    const kind = bytes.toString("ascii", offset, offset + 4)
    const length = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    const next = start + length + (length % 2)
    if (next > end) return null
    if (kind === "VP8X") {
      if (length < 10) return null
      animated = Boolean((bytes[start] as number) & 0x02)
      canvasWidth = uint24(bytes, start + 4) + 1
      canvasHeight = uint24(bytes, start + 7) + 1
      if (!boundedDimensions(canvasWidth, canvasHeight)) return null
    } else if (kind === "ANIM") {
      if (length < 6) return null
      background = [
        bytes[start] as number,
        bytes[start + 1] as number,
        bytes[start + 2] as number,
        bytes[start + 3] as number,
      ]
    } else if (kind === "ANMF" && animated) {
      if (length < 16 || !boundedDimensions(canvasWidth, canvasHeight)) return null
      const x = uint24(bytes, start) * 2
      const y = uint24(bytes, start + 3) * 2
      const frameWidth = uint24(bytes, start + 6) + 1
      const frameHeight = uint24(bytes, start + 9) + 1
      if (
        !boundedDimensions(frameWidth, frameHeight) ||
        x + frameWidth > canvasWidth ||
        y + frameHeight > canvasHeight
      )
        return null
      const inner = bytes.subarray(start + 16, start + length)
      if (inner.length < 8) return null
      let hasImage = false
      let hasAlpha = false
      for (let innerOffset = 0; innerOffset + 8 <= inner.length; ) {
        const innerKind = inner.toString("ascii", innerOffset, innerOffset + 4)
        const innerLength = inner.readUInt32LE(innerOffset + 4)
        const innerNext = innerOffset + 8 + innerLength + (innerLength % 2)
        if (innerNext > inner.length) return null
        if (innerKind === "VP8 " || innerKind === "VP8L") {
          const dimensions = imageDimensions(inner, innerOffset + 8, innerLength, innerKind)
          if (
            !dimensions ||
            !boundedDimensions(dimensions.width, dimensions.height) ||
            dimensions.width !== frameWidth ||
            dimensions.height !== frameHeight
          )
            return null
          hasImage = true
        }
        if (innerKind === "ALPH") hasAlpha = true
        innerOffset = innerNext
      }
      if (!hasImage) return null
      // A standalone VP8X container lets libwebp decode this ANMF image alone.
      const first = Buffer.alloc(30 + inner.length)
      first.write("RIFF", 0, "ascii")
      first.writeUInt32LE(first.length - 8, 4)
      first.write("WEBPVP8X", 8, "ascii")
      first.writeUInt32LE(10, 16)
      first[20] = hasAlpha ? 0x10 : 0
      first.writeUIntLE(frameWidth - 1, 24, 3)
      first.writeUIntLE(frameHeight - 1, 27, 3)
      inner.copy(first, 30)
      return {
        canvasWidth,
        canvasHeight,
        frameWidth,
        frameHeight,
        x,
        y,
        background,
        replace: Boolean((bytes[start + 15] as number) & 0x02),
        bytes: first,
      }
    } else if ((kind === "VP8 " || kind === "VP8L") && !animated) {
      const dimensions = imageDimensions(bytes, start, length, kind)
      if (!dimensions || !boundedDimensions(dimensions.width, dimensions.height)) return null
      if (canvasWidth && (dimensions.width !== canvasWidth || dimensions.height !== canvasHeight))
        return null
      canvasWidth = dimensions.width
      canvasHeight = dimensions.height
      return {
        canvasWidth,
        canvasHeight,
        frameWidth: canvasWidth,
        frameHeight: canvasHeight,
        x: 0,
        y: 0,
        background,
        replace: true,
        bytes: bytes.subarray(0, end),
      }
    }
    offset = next
  }
  return null
}
