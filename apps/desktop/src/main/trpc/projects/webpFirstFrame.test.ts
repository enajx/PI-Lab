import { describe, expect, test } from "vitest"
import { firstWebPFrame } from "./webpFirstFrame"

const LOSSLESS = Buffer.from("UklGRhwAAABXRUJQVlA4TA8AAAAvAQAAAAcQ/Y/+ByKi/wEA", "base64")
const ANIMATED = Buffer.from(
  "UklGRsAAAABXRUJQVlA4WAoAAAACAAAAAQAAAAAAQU5JTQYAAAD/////AABBTk1GSAAAAAAAAAAAAAEAAAAAAMgAAAJWUDggMAAAANABAJ0BKgIAAQACADQloAJ0ugH4AAOwAP7wxAv/ILlhdcjX/yA/5Af8gP/48gAAAEFOTUZEAAAAAAAAAAAAAQAAAAAAyAAAAFZQOCAsAAAAlAEAnQEqAgABAAAANCWgAnS6AAOYAP75k2//kB//kB//kB//ID/iF3sgMAA=",
  "base64",
)

describe("firstWebPFrame", () => {
  test("extracts only the first animation frame as a static bounded WebP", () => {
    const frame = firstWebPFrame(ANIMATED)
    expect(frame).toMatchObject({
      canvasWidth: 2,
      canvasHeight: 1,
      frameWidth: 2,
      frameHeight: 1,
      x: 0,
      y: 0,
    })
    expect(frame?.bytes.toString("ascii", 8, 12)).toBe("WEBP")
    expect(frame?.bytes.includes(Buffer.from("ANMF"))).toBe(false)
  })

  test("rejects a small wrapper around a huge VP8 image before decode", () => {
    const bytes = Buffer.from(ANIMATED)
    const image = bytes.indexOf(Buffer.from("VP8 "))
    expect(image).toBeGreaterThan(0)
    bytes.writeUInt16LE(0x3fff, image + 8 + 6)
    bytes.writeUInt16LE(0x3fff, image + 8 + 8)
    expect(firstWebPFrame(bytes)).toBeNull()
  })

  test("rejects malformed lossless dimensions and truncated chunks", () => {
    const huge = Buffer.from(LOSSLESS)
    const image = huge.indexOf(Buffer.from("VP8L"))
    expect(image).toBeGreaterThan(0)
    huge.fill(0xff, image + 8 + 1, image + 8 + 5)
    expect(firstWebPFrame(huge)).toBeNull()
    expect(firstWebPFrame(ANIMATED.subarray(0, ANIMATED.length - 1))).toBeNull()
  })
})
