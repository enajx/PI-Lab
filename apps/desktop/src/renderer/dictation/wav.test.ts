import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  base64FromBytes,
  encodeWav16,
  peakBlockLevel,
  resample,
  rmsLevel,
  SPEECH_LEVEL,
  speechDetected,
} from "./wav"

describe("resample", () => {
  test("downsamples 48 kHz to 16 kHz with one output sample per three input samples", () => {
    const input = new Float32Array(4800).fill(0.5)
    const output = resample(input, 48_000, 16_000)
    expect(output.length).toBe(1600)
    expect(Math.abs((output[800] ?? 0) - 0.5)).toBeLessThan(1e-6)
  })

  test("keeps a slow sine wave's shape at 44.1 kHz to 16 kHz", () => {
    const fromRate = 44_100
    const input = Float32Array.from({ length: fromRate }, (_, i) =>
      Math.sin((2 * Math.PI * 440 * i) / fromRate),
    )
    const output = resample(input, fromRate, 16_000)
    expect(output.length).toBe(16_000)
    for (const index of [100, 5_000, 12_345]) {
      const expected = Math.sin((2 * Math.PI * 440 * index) / 16_000)
      expect(Math.abs((output[index] ?? 0) - expected)).toBeLessThan(0.1)
    }
  })

  test("returns the same samples when the rates match", () => {
    const input = Float32Array.from([0.1, -0.2, 0.3])
    expect(Array.from(resample(input, 16_000, 16_000))).toEqual(Array.from(input))
  })
})

describe("encodeWav16", () => {
  test("writes a 16 kHz mono 16-bit PCM RIFF header and clamped little-endian samples", () => {
    const bytes = encodeWav16(Float32Array.from([0, 1, -1, 2, 0.5]), 16_000)
    const view = new DataView(bytes.buffer)
    const text = (offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4))
    expect(bytes.length).toBe(44 + 5 * 2)
    expect(text(0)).toBe("RIFF")
    expect(view.getUint32(4, true)).toBe(36 + 10)
    expect(text(8)).toBe("WAVE")
    expect(text(12)).toBe("fmt ")
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(28, true)).toBe(32_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(text(36)).toBe("data")
    expect(view.getUint32(40, true)).toBe(10)
    expect([0, 1, 2, 3, 4].map((i) => view.getInt16(44 + i * 2, true))).toEqual([
      0, 32767, -32768, 32767, 16384,
    ])
  })
})

describe("base64FromBytes", () => {
  test("matches the standard encoding for long inputs", () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => i % 256)
    expect(base64FromBytes(bytes)).toBe(Buffer.from(bytes).toString("base64"))
  })
})

describe("rmsLevel", () => {
  test("is 0 for silence and the amplitude over √2 for a full sine cycle", () => {
    expect(rmsLevel(new Float32Array(128))).toBe(0)
    const sine = Float32Array.from(
      { length: 1000 },
      (_, i) => 0.5 * Math.sin((2 * Math.PI * i) / 1000),
    )
    expect(rmsLevel(sine)).toBeCloseTo(0.5 / Math.SQRT2, 3)
  })
})

/** The 16-bit mono speech fixture ("hello world", recorded with macOS say) as floats. */
function helloWorldSamples(): Float32Array {
  const wav = readFileSync(
    join(import.meta.dirname, "../../main/dictation/__fixtures__/hello-world.wav"),
  )
  const data = wav.indexOf("data") + 8
  const count = (wav.length - data) / 2
  return Float32Array.from({ length: count }, (_, i) => wav.readInt16LE(data + i * 2) / 32768)
}

describe("speech detection", () => {
  test("a silent recording has no speech", () => {
    const silence = new Float32Array(48_000)
    expect(peakBlockLevel(silence)).toBe(0)
    expect(speechDetected(silence)).toBe(false)
    // Faint noise well below speech, as from a quiet room.
    const hiss = Float32Array.from({ length: 48_000 }, (_, i) => (i % 2 ? 0.002 : -0.002))
    expect(speechDetected(hiss)).toBe(false)
  })

  test("the hello-world fixture has speech", () => {
    const samples = helloWorldSamples()
    expect(peakBlockLevel(samples)).toBeGreaterThan(SPEECH_LEVEL * 10)
    expect(speechDetected(samples)).toBe(true)
  })
})
