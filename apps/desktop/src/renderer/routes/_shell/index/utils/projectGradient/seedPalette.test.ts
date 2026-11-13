import fc from "fast-check"
import { describe, expect, test } from "vitest"
import {
  BROWN_PRONE_HUES,
  EXCLUDED_HUES,
  hexToOklch,
  inSrgbGamut,
  PALETTE_CHROMA,
  PALETTE_LIGHTNESS,
  seedPalette,
  seedPaletteOklch,
} from "./seedPalette"

const seedArb = fc.integer({ min: 0, max: 0xffffffff })

describe("seedPalette", () => {
  test("the same seed always gives the same colors", () => {
    fc.assert(fc.property(seedArb, (seed) => seedPalette(seed).join() === seedPalette(seed).join()))
    expect(seedPalette(1)).not.toEqual(seedPalette(2))
  })

  test("every color is inside the lightness and chroma ranges and in the sRGB gamut", () => {
    fc.assert(
      fc.property(seedArb, (seed) => {
        for (const color of seedPaletteOklch(seed)) {
          expect(color.l).toBeGreaterThanOrEqual(PALETTE_LIGHTNESS.min)
          expect(color.l).toBeLessThanOrEqual(PALETTE_LIGHTNESS.max)
          expect(color.c).toBeGreaterThanOrEqual(PALETTE_CHROMA.min)
          expect(color.c).toBeLessThanOrEqual(PALETTE_CHROMA.max)
          expect(inSrgbGamut(color)).toBe(true)
        }
      }),
    )
  })

  test("no color is green, olive, khaki or brown", () => {
    fc.assert(
      fc.property(seedArb, (seed) => {
        for (const color of seedPaletteOklch(seed)) {
          // Greens, olives, khakis and most yellows: the excluded hue band.
          const excluded = color.h >= EXCLUDED_HUES.from && color.h < EXCLUDED_HUES.to
          expect(excluded).toBe(false)
          // Oranges read as brown when dark, so they must stay light.
          if (color.h >= BROWN_PRONE_HUES.from && color.h < BROWN_PRONE_HUES.to) {
            expect(color.l).toBeGreaterThanOrEqual(BROWN_PRONE_HUES.minLightness)
          }
        }
      }),
    )
  })

  test("the hex output matches the OKLCH colors it was made from", () => {
    fc.assert(
      fc.property(seedArb, (seed) => {
        const hexes = seedPalette(seed)
        const colors = seedPaletteOklch(seed)
        expect(hexes).toHaveLength(colors.length)
        hexes.forEach((hex, index) => {
          expect(hex).toMatch(/^#[0-9a-f]{6}$/)
          const back = hexToOklch(hex)
          const source = colors[index]
          if (!source) throw new Error("missing source color")
          // 8-bit rounding moves L and C by well under 0.01.
          expect(Math.abs(back.l - source.l)).toBeLessThan(0.01)
          expect(Math.abs(back.c - source.c)).toBeLessThan(0.01)
        })
      }),
    )
  })
})
