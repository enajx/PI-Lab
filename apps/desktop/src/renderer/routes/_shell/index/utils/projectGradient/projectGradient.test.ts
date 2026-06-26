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
    expect(a.animation).toEqual(b.animation)
  })

  test("different ids produce different gradients", () => {
    const a = projectGradient("photon-drift")
    const b = projectGradient("lattice-qcd")
    expect(a.background).not.toBe(b.background)
  })

  test("returns a CSS linear-gradient and an inline SVG grain data URL", () => {
    const { background, grainUrl } = projectGradient("anything")
    expect(background.startsWith("linear-gradient(")).toBe(true)
    expect(grainUrl.startsWith("data:image/svg+xml,")).toBe(true)
  })

  test("animation timing sits in the documented ranges", () => {
    const { animation } = projectGradient("anything")
    // durationSec = 28 + (seed % 25) ⇒ 28..52.
    expect(animation.durationSec).toBeGreaterThanOrEqual(28)
    expect(animation.durationSec).toBeLessThanOrEqual(52)
    // A negative (mid-cycle) phase offset.
    expect(animation.delaySec).toBeLessThanOrEqual(0)
  })

  // Property-based: invariants that must hold for ALL ids. fast-check generates
  // hundreds of strings (incl. unicode, empty) and shrinks any failure.
  test("duration is always within 28..52s and delay is always <= 0", () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        const { animation } = projectGradient(id)
        return (
          animation.durationSec >= 28 &&
          animation.durationSec <= 52 &&
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
          a.animation.durationSec === b.animation.durationSec &&
          a.animation.delaySec === b.animation.delaySec
        )
      }),
    )
  })
})
