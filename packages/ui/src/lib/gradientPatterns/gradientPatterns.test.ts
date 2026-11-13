import { describe, expect, test } from "vitest"
import {
  buildGrainSVG,
  buildLayerSVG,
  buildSVG,
  GRADIENT_PATTERN_DEFAULTS,
  generateConfig,
  mulberry32,
  toDataUri,
} from "./gradientPatterns"

describe("gradientPatterns", () => {
  test("mulberry32 is a deterministic seeded stream", () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const seqA = [a(), a(), a()]
    const seqB = [b(), b(), b()]
    expect(seqA).toEqual(seqB)
    expect(new Set(seqA).size).toBe(3)
    for (const value of seqA) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  test("generateConfig is reproducible for a given seed and varies across seeds", () => {
    expect(generateConfig({ seed: 7 })).toEqual(generateConfig({ seed: 7 }))
    expect(generateConfig({ seed: 7 })).not.toEqual(generateConfig({ seed: 8 }))

    const cfg = generateConfig({ seed: 7 })
    expect(cfg.shapes.length).toBeGreaterThanOrEqual(1)
    expect(cfg.shapes.length).toBeLessThanOrEqual(6)
    expect(["#FFFFFF", "#000000"]).toContain(cfg.lightDarkMode)
  })

  test("about 1 in 5 seeds get the dark base", () => {
    const seeds = Array.from({ length: 4000 }, (_, seed) => seed)
    const dark = seeds.filter((seed) => generateConfig({ seed }).lightDarkMode === "#000000")
    const share = dark.length / seeds.length
    expect(share).toBeGreaterThan(0.17)
    expect(share).toBeLessThan(0.23)
  })

  test("buildSVG renders the full reference look: opaque base, blur, and turbulence", () => {
    const svg = buildSVG(generateConfig({ seed: 1 }))
    expect(svg.startsWith("<svg")).toBe(true)
    expect(svg).toContain(`stdDeviation="${GRADIENT_PATTERN_DEFAULTS.blur}"`)
    expect(svg).toContain("feTurbulence")
    // The opaque light/dark base rect anchors the single-SVG look.
    expect(svg).toMatch(/<rect width="1600" height="1600" fill="#(FFFFFF|000000)"\/>/)
  })

  test("buildLayerSVG is transparent and shapes-only, but keeps the blur", () => {
    const svg = buildLayerSVG(generateConfig({ seed: 1 }))
    expect(svg).toContain("feGaussianBlur")
    // No opaque base and no grain — so layers stack and blend.
    expect(svg).not.toMatch(/<rect width="1600" height="1600" fill="#/)
    expect(svg).not.toContain("feTurbulence")
  })

  test("blur is the whole trick — dropping it changes the layer output", () => {
    const cfg = generateConfig({ seed: 3 })
    expect(buildLayerSVG(cfg, { blur: 250 })).not.toBe(buildLayerSVG(cfg, { blur: 0 }))
    expect(buildLayerSVG(cfg, { blur: 0 })).toContain('stdDeviation="0"')
  })

  test("buildGrainSVG is the reference noise layer, sized to its box instead of a repeating tile", () => {
    const grain = buildGrainSVG({
      baseFrequency: GRADIENT_PATTERN_DEFAULTS.baseFrequency,
      numOctaves: GRADIENT_PATTERN_DEFAULTS.numOctaves,
    })
    // Same filter chain as the full reference SVG: turbulence on gray, overlay-blended.
    expect(grain).toContain(
      `<feTurbulence baseFrequency="${GRADIENT_PATTERN_DEFAULTS.baseFrequency}"`,
    )
    expect(grain).toContain('mode="overlay"')
    expect(grain).toContain("fill:gray")
    // The reference's 1600-unit canvas, cropped to the box like CSS "cover": the noise
    // scales with the card exactly as the reference SVG does, so at card size it is
    // finer than a device pixel (crisp, per-pixel grain) and never repeats as tiles.
    expect(grain).toContain('viewBox="0 0 1600 1600"')
    expect(grain).toContain('preserveAspectRatio="xMidYMid slice"')
    expect(grain).not.toMatch(/<svg [^>]*\swidth=/)
  })

  test("toDataUri round-trips SVG markup through a CSS-safe data URI", () => {
    const svg = buildLayerSVG(generateConfig({ seed: 5 }))
    const uri = toDataUri(svg)
    expect(uri.startsWith("data:image/svg+xml,")).toBe(true)
    // '#' from hex colors must be escaped so CSS url() does not truncate it.
    expect(uri).not.toContain("#")
    expect(decodeURIComponent(uri.slice("data:image/svg+xml,".length))).toBe(svg)
  })
})
