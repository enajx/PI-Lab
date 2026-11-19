import { describe, expect, it } from "vitest"
import { bytesToBase64, PcmChunker } from "./pcm"

describe("bytesToBase64", () => {
  it("matches Node's base64 for any length", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 8000, 40_001]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37) % 256)
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"))
    }
  })
})

describe("PcmChunker", () => {
  it("numbers chunks from 0 and hands the rest over at finish", () => {
    const chunker = new PcmChunker(4)
    expect(chunker.push(new Uint8Array([1, 2]))).toEqual([])
    expect(chunker.push(new Uint8Array([3, 4, 5, 6, 7, 8, 9]))).toEqual([
      { seq: 0, bytes: new Uint8Array([1, 2, 3, 4]) },
      { seq: 1, bytes: new Uint8Array([5, 6, 7, 8]) },
    ])
    expect(chunker.finish()).toEqual({ seq: 2, bytes: new Uint8Array([9]) })
  })
})
