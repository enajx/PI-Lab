import { describe, expect, test } from "vitest"
import { jpegDimensions } from "./jpegDimensions"

/** A minimal JPEG marker stream with dimensions in its frame header. */
function jpegHeader(width: number, height: number): Buffer {
  const bytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x00, 0x00,
    0x00,
  ])
  bytes.writeUInt16BE(height, 13)
  bytes.writeUInt16BE(width, 15)
  return bytes
}

describe("jpegDimensions", () => {
  test("reads a frame header before the pixel decoder runs", () => {
    expect(jpegDimensions(jpegHeader(2, 1))).toEqual({ width: 2, height: 1 })
    expect(jpegDimensions(jpegHeader(16_384, 16_384))).toEqual({
      width: 16_384,
      height: 16_384,
    })
  })

  test("rejects truncated segments and missing frame headers", () => {
    const truncated = jpegHeader(2, 1)
    truncated.writeUInt16BE(0xffff, 10)
    expect(jpegDimensions(truncated)).toBeNull()
    expect(jpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xda]))).toBeNull()
  })
})
