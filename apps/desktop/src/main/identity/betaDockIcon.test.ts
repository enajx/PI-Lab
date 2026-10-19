import { describe, expect, test } from "vitest"
import { recolorBetaDockBitmap } from "./betaDockIcon"

describe("public Beta Dock icon", () => {
  test("uses the Stable palette on the tile and keeps the symbol white", () => {
    // macOS NativeImage bitmaps use premultiplied BGRA pixels.
    const source = Buffer.from([0, 50, 100, 255, 255, 255, 255, 255, 0, 25, 50, 128, 0, 0, 0, 0])
    const recolored = recolorBetaDockBitmap(source, 2, 2, {
      sourceGradient: Uint8Array.from([100, 50, 0, 100, 50, 0]),
      targetGradient: Uint8Array.from([0, 100, 200, 0, 100, 200]),
    })
    expect([...recolored.subarray(0, 4)]).toEqual([200, 100, 0, 255])
    expect([...recolored.subarray(4, 8)]).toEqual([255, 255, 255, 255])
    expect(recolored[11]).toBe(128)
    expect([...recolored.subarray(12, 16)]).toEqual([0, 0, 0, 0])
  })
})
