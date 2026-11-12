import { describe, expect, test } from "vitest"
import { WAVE_LINES, wavePoints } from "./Waveform"

describe("wavePoints", () => {
  test("is flat when silent, stays within -1..1 when loud, and is pinned at both ends", () => {
    for (const line of WAVE_LINES) {
      expect(wavePoints(line, 0, 1.3, 40).every((y) => y === 0)).toBe(true)
      const loud = wavePoints(line, 1, 1.3, 40)
      expect(Math.max(...loud.map(Math.abs))).toBeLessThanOrEqual(1)
      expect(Math.max(...loud.map(Math.abs))).toBeGreaterThan(0.2)
      expect(Math.abs(loud[0] ?? 1)).toBeLessThan(0.05)
      expect(Math.abs(loud[39] ?? 1)).toBeLessThan(0.05)
    }
  })
})
