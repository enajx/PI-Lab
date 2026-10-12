import { beforeEach, describe, expect, test, vi } from "vitest"

const electron = vi.hoisted(() => ({ createFromBuffer: vi.fn() }))
vi.mock("electron", () => ({ nativeImage: { createFromBuffer: electron.createFromBuffer } }))

import { electronThumbnailImageProcessor } from "./electronThumbnailImage"

/** Minimal header to test the predecode JPEG guard with a mocked Electron decoder. */
function jpegHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(25)
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 7, 8])
  bytes.writeUInt16BE(height, 13)
  bytes.writeUInt16BE(width, 15)
  return bytes
}

describe("Electron thumbnail decoder JPEG guard (mocked nativeImage)", () => {
  beforeEach(() => electron.createFromBuffer.mockClear())

  test("does not reach nativeImage with a huge or malformed JPEG header", () => {
    expect(electronThumbnailImageProcessor.inspect(jpegHeader(16_384, 16_384))).toBeNull()
    const malformed = jpegHeader(2, 1)
    malformed.writeUInt16BE(0xffff, 10)
    expect(electronThumbnailImageProcessor.inspect(malformed)).toBeNull()
    expect(electron.createFromBuffer).not.toHaveBeenCalled()
  })
})
