import { TRPCError } from "@trpc/server"

export const MAX_THUMBNAIL_BYTES = 1_000_000
const MAX_IMAGE_PIXELS = 16_000_000
const DATA_URL = /^data:image\/(png|gif);base64,([A-Za-z0-9+/]+={0,2})$/
const STORED_DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/

export interface ThumbnailImageProcessor {
  /** Decode the image and return a static first-frame PNG badge. */
  inspect(bytes: Buffer): { width: number; height: number; badgeDataUrl: string } | null
  /** Legacy WebP decode loads WASM only when a stored WebP badge is requested. */
  inspectWebP(
    bytes: Buffer,
  ): Promise<{ width: number; height: number; badgeDataUrl: string } | null>
}

export interface ValidatedThumbnail {
  bytes: Buffer
  type: "png" | "gif"
  badgeDataUrl: string
}

/** Validate actual encoded bytes and decoded dimensions before storing artwork. */
export function validateThumbnail(
  dataUrl: string,
  processor: ThumbnailImageProcessor,
): ValidatedThumbnail {
  const match = DATA_URL.exec(dataUrl)
  if (!match) throw invalidThumbnail("Choose a PNG or GIF image.")
  const type = match[1] as ValidatedThumbnail["type"]
  const encoded = match[2] as string
  // Check before allocating a decoded copy or entering an image decoder.
  if (decodedLength(encoded) > MAX_THUMBNAIL_BYTES) {
    throw invalidThumbnail("Thumbnail is larger than 1 MB.")
  }
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.length > MAX_THUMBNAIL_BYTES) throw invalidThumbnail("Thumbnail is larger than 1 MB.")
  if (bytes.length < (type === "png" ? 24 : 10)) {
    throw invalidThumbnail("Could not decode this image.")
  }
  const signatureMatches =
    (type === "png" && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
    (type === "gif" && /^(GIF87a|GIF89a)$/.test(bytes.toString("ascii", 0, 6)))
  if (!signatureMatches) throw invalidThumbnail("Image content does not match its format.")
  const width = type === "png" ? bytes.readUInt32BE(16) : bytes.readUInt16LE(6)
  const height = type === "png" ? bytes.readUInt32BE(20) : bytes.readUInt16LE(8)
  if (width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) {
    throw invalidThumbnail("Image dimensions are too large.")
  }
  if (type !== "gif" && Math.max(width, height) > 640) {
    throw invalidThumbnail("Still images must fit within 640 pixels on their longest edge.")
  }
  const image = processor.inspect(bytes)
  if (
    !image ||
    image.width < 1 ||
    image.height < 1 ||
    image.width * image.height > MAX_IMAGE_PIXELS ||
    !image.badgeDataUrl.startsWith("data:image/png;base64,")
  ) {
    throw invalidThumbnail("Could not decode this image, or its dimensions are too large.")
  }
  if (image.width !== width || image.height !== height)
    throw invalidThumbnail("Image dimensions do not match its data.")
  return { bytes, type, badgeDataUrl: image.badgeDataUrl }
}

/** Return a clear, user-visible input error without changing stored artwork. */
function invalidThumbnail(message: string): TRPCError {
  return new TRPCError({ code: "BAD_REQUEST", message })
}

/** Decode a stored row for a separately requested card or badge payload. */
export async function readStoredThumbnail(
  dataUrl: string | null,
  variant: "card" | "badge",
  processor: ThumbnailImageProcessor,
): Promise<{ dataUrl: string | null; tooLarge: boolean }> {
  if (!dataUrl) return { dataUrl: null, tooLarge: false }
  const match = STORED_DATA_URL.exec(dataUrl)
  if (!match || decodedLength(match[2] as string) > MAX_THUMBNAIL_BYTES) {
    return { dataUrl: null, tooLarge: true }
  }
  const bytes = Buffer.from(match[2] as string, "base64")
  if (bytes.length > MAX_THUMBNAIL_BYTES) return { dataUrl: null, tooLarge: true }
  if (variant === "card") return { dataUrl, tooLarge: false }
  const image = match[1] === "webp" ? await processor.inspectWebP(bytes) : processor.inspect(bytes)
  return { dataUrl: image?.badgeDataUrl ?? null, tooLarge: image === null }
}

/** Base64 payload length with padding removed, before allocating a Buffer. */
function decodedLength(encoded: string): number {
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
  return Math.floor((encoded.length * 3) / 4) - padding
}
