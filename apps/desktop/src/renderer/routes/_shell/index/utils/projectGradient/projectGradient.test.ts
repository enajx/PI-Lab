import fc from "fast-check"
import { describe, expect, test } from "vitest"
import { hashString, projectGradient } from "./projectGradient"

const PALETTE = ["#FFC700", "#18A0FB", "#EE46D3"]

describe("projectGradient", () => {
  test("is stable — the same seed+palette yields an identical artwork", () => {
    const a = projectGradient(1234, PALETTE)
    const b = projectGradient(1234, PALETTE)
    expect(a.background).toBe(b.background)
    expect(a.baseColor).toBe(b.baseColor)
    expect(a.grainUrl).toBe(b.grainUrl)
    expect(a.layerBackgrounds).toEqual(b.layerBackgrounds)
    expect(a.variant).toEqual(b.variant)
    expect(a.animation).toEqual(b.animation)
  })

  test("different seeds diverge; the palette shapes the fill colors", () => {
    const a = projectGradient(1, PALETTE)
    const b = projectGradient(2, PALETTE)
    expect(a.layerBackgrounds).not.toEqual(b.layerBackgrounds)

    // Every fill in the baked SVGs comes from the given palette (case-insensitive,
    // url-encoded in the data URI). At least one palette color must appear.
    const encoded = a.layerBackgrounds.join(" ").toUpperCase()
    expect(PALETTE.some((color) => encoded.includes(encodeURIComponent(color).toUpperCase()))).toBe(
      true,
    )
  })

  test("a project set receives genuinely varied motions", () => {
    const motions = new Set(
      Array.from({ length: 120 }, (_, index) => projectGradient(index, PALETTE).variant.motion),
    )
    expect(motions.size).toBeGreaterThanOrEqual(5)
  })

  test("bakes three distinct transparent layers and an inline turbulence grain", () => {
    const { background, baseColor, layerBackgrounds, grainUrl } = projectGradient(7, PALETTE)

    expect(background.startsWith("linear-gradient(")).toBe(true)
    expect(baseColor).toMatch(/^#(FFFFFF|000000)$/)
    expect(layerBackgrounds).toHaveLength(3)
    expect(new Set(layerBackgrounds).size).toBe(3)
    for (const layer of layerBackgrounds) {
      expect(layer.startsWith('url("data:image/svg+xml,')).toBe(true)
      // A transparent shapes-only field: no opaque base rect (that lives outside).
      expect(layer).toContain(encodeURIComponent("feGaussianBlur"))
    }

    expect(grainUrl.startsWith("data:image/svg+xml,")).toBe(true)
    expect(grainUrl).toContain(encodeURIComponent("fractalNoise"))
  })

  test("animation timing sits in the documented ranges", () => {
    const { animation } = projectGradient(99, PALETTE)
    expect(animation.durationSec).toBeGreaterThanOrEqual(6)
    expect(animation.durationSec).toBeLessThanOrEqual(9)
    // A negative (mid-cycle) phase offset.
    expect(animation.delaySec).toBeLessThanOrEqual(0)
  })

  test("hashString is deterministic and unsigned", () => {
    expect(hashString("photon-drift")).toBe(hashString("photon-drift"))
    expect(hashString("photon-drift")).not.toBe(hashString("lattice-qcd"))
    expect(hashString("anything") >>> 0).toBe(hashString("anything"))
  })

  // Property-based: invariants that must hold for ALL seeds.
  test("base duration is always within 6..9s and delay is always in (-dur, 0]", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
        const { animation } = projectGradient(seed, PALETTE)
        return (
          animation.durationSec >= 6 &&
          animation.durationSec <= 9 &&
          animation.delaySec <= 0 &&
          animation.delaySec > -animation.durationSec
        )
      }),
    )
  })
})
