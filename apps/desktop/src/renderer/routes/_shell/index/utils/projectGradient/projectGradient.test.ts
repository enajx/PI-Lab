import fc from "fast-check"
import { describe, expect, test } from "vitest"
import { projectGradient } from "./projectGradient"

describe("projectGradient", () => {
  // Example-based: pin down the concrete, human-meaningful behaviour.
  test("is stable — the same id yields an identical gradient + animation", () => {
    const a = projectGradient("photon-drift")
    const b = projectGradient("photon-drift")
    expect(a.background).toBe(b.background)
    expect(a.grainUrl).toBe(b.grainUrl)
    expect(a.layerBackgrounds).toEqual(b.layerBackgrounds)
    expect(a.variant).toEqual(b.variant)
    expect(a.animation).toEqual(b.animation)
  })

  test("a project set receives genuinely varied shapes, motions, and palettes", () => {
    const gradients = Array.from({ length: 120 }, (_, index) => projectGradient(`project-${index}`))

    expect(new Set(gradients.map(({ variant }) => variant.shape)).size).toBeGreaterThanOrEqual(10)
    expect(new Set(gradients.map(({ variant }) => variant.motion)).size).toBeGreaterThanOrEqual(5)
    expect(new Set(gradients.map(({ background }) => background)).size).toBeGreaterThanOrEqual(10)
  })

  test("uses broad eddy and bloom fields instead of pinched vortex or starburst petals", () => {
    const gradients = Array.from({ length: 240 }, (_, index) =>
      projectGradient(`shape-sample-${index}`),
    )
    const shapes = new Set(gradients.map(({ variant }) => variant.shape))
    const fields = gradients.flatMap(({ layerBackgrounds }) => layerBackgrounds)

    expect(shapes).toContain("eddy")
    expect(shapes).toContain("bloom")
    expect(shapes).not.toContain("vortex")
    expect(shapes).not.toContain("petals")
    expect(fields.some((field) => field.includes("repeating-conic-gradient"))).toBe(false)
  })

  test("returns a light pastel base, three organic color fields, and strong inline SVG grain", () => {
    const { background, layerBackgrounds, grainUrl } = projectGradient("anything")
    expect(background.startsWith("linear-gradient(")).toBe(true)
    expect(layerBackgrounds).toHaveLength(3)
    expect(new Set(layerBackgrounds).size).toBe(3)

    const css = [background, ...layerBackgrounds].join(" ")
    const lightnesses = [...css.matchAll(/hsl\([^ ]+ [^ ]+% ([\d.]+)%/g)].map((match) =>
      Number(match[1]),
    )
    expect(lightnesses.length).toBeGreaterThan(0)
    expect(Math.min(...lightnesses)).toBeGreaterThanOrEqual(76)

    expect(grainUrl.startsWith("data:image/svg+xml,")).toBe(true)
    expect(grainUrl).toContain("fractalNoise")
    expect(grainUrl).toContain("baseFrequency='.82'")
    expect(grainUrl).toContain("numOctaves='4'")
  })

  test("animation timing sits in the documented ranges", () => {
    const { animation } = projectGradient("anything")
    expect(animation.durationSec).toBeGreaterThanOrEqual(8)
    expect(animation.durationSec).toBeLessThanOrEqual(12)
    // A negative (mid-cycle) phase offset.
    expect(animation.delaySec).toBeLessThanOrEqual(0)
  })

  // Property-based: invariants that must hold for ALL ids. fast-check generates
  // hundreds of strings (incl. unicode, empty) and shrinks any failure.
  test("base duration is always within 8..12s and delay is always <= 0", () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        const { animation } = projectGradient(id)
        return (
          animation.durationSec >= 8 &&
          animation.durationSec <= 12 &&
          animation.delaySec <= 0 &&
          // The negative offset never exceeds the cycle length.
          animation.delaySec > -animation.durationSec
        )
      }),
    )
  })

  test("is deterministic — same id maps to the same animation timing", () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        const a = projectGradient(id)
        const b = projectGradient(id)
        return (
          a.background === b.background &&
          a.variant.shape === b.variant.shape &&
          a.variant.motion === b.variant.motion &&
          a.animation.durationSec === b.animation.durationSec &&
          a.animation.delaySec === b.animation.delaySec
        )
      }),
    )
  })
})
