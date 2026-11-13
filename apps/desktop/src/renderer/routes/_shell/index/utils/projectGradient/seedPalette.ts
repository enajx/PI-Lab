/**
 * Seeded OKLCH palettes for project-card gradients.
 *
 * From a seed we pick a base hue and a harmony (analogous, or analogous plus one
 * soft complementary accent). Every color stays in a mid lightness and chroma
 * range, so the cards get soft greens, warm yellows, earthy browns and muted
 * blues, never very dark or neon colors. Colors are converted to sRGB hex for the
 * SVG generator. The same seed always gives the same palette.
 */

import { mulberry32 } from "@pi-lab/ui"

export interface OklchColor {
  /** Perceptual lightness, 0..1. */
  l: number
  /** Chroma (colorfulness), 0 is gray. */
  c: number
  /** Hue angle in degrees, 0..360. */
  h: number
}

export const PALETTE_LIGHTNESS = { min: 0.55, max: 0.85 } as const
/**
 * The sRGB gamut holds at least chroma 0.074 at every hue for lightness 0.55..0.85,
 * so pulling a color into gamut never takes it below `min`.
 */
export const PALETTE_CHROMA = { min: 0.04, max: 0.12 } as const

/** Analogous hue step in degrees. */
const ANALOGOUS_STEP = { min: 20, max: 40 } as const
/** Share of seeds that get a soft complementary accent instead of a third analogous hue. */
const COMPLEMENTARY_SHARE = 0.35
/** Small margin for float error when testing the sRGB gamut. */
const GAMUT_EPSILON = 1e-6

/** Linear-light sRGB channels, in 0..1 when the color is in gamut. */
interface LinearRgb {
  r: number
  g: number
  b: number
}

/** OKLCH to linear sRGB (Björn Ottosson's Oklab matrices). */
function oklchToLinearSrgb({ l, c, h }: OklchColor): LinearRgb {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return {
    r: 4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp,
    g: -1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp,
    b: -0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp,
  }
}

/** Whether an OKLCH color can be shown in sRGB without clipping. */
export function inSrgbGamut(color: OklchColor): boolean {
  const { r, g, b } = oklchToLinearSrgb(color)
  return [r, g, b].every((channel) => channel >= -GAMUT_EPSILON && channel <= 1 + GAMUT_EPSILON)
}

/** Lower chroma (same lightness and hue) until the color is in the sRGB gamut. */
function intoGamut(color: OklchColor): OklchColor {
  if (inSrgbGamut(color)) return color
  let low = 0
  let high = color.c
  for (let step = 0; step < 24; step++) {
    const mid = (low + high) / 2
    if (inSrgbGamut({ ...color, c: mid })) low = mid
    else high = mid
  }
  return { ...color, c: low }
}

function linearToGammaByte(channel: number): number {
  const clamped = Math.min(1, Math.max(0, channel))
  const gamma = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
  return Math.round(gamma * 255)
}

function gammaByteToLinear(byte: number): number {
  const value = byte / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

/** OKLCH to `#rrggbb`. The color must already be in gamut. */
function oklchToHex(color: OklchColor): string {
  if (!inSrgbGamut(color))
    throw new Error(`OKLCH color out of sRGB gamut: ${JSON.stringify(color)}`)
  const { r, g, b } = oklchToLinearSrgb(color)
  return `#${[r, g, b]
    .map((channel) => linearToGammaByte(channel).toString(16).padStart(2, "0"))
    .join("")}`
}

/** `#rrggbb` to OKLCH (used to check the hex output). */
export function hexToOklch(hex: string): OklchColor {
  const value = hex.replace("#", "")
  const [r, g, b] = [0, 2, 4].map((start) =>
    gammaByteToLinear(Number.parseInt(value.slice(start, start + 2), 16)),
  ) as [number, number, number]
  const lp = Math.cbrt(0.4122214708 * r + 0.5363288613 * g + 0.0514459929 * b)
  const mp = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const sp = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const l = 0.2104542553 * lp + 0.793617785 * mp - 0.0040720468 * sp
  const a = 1.9779984951 * lp - 2.428592205 * mp + 0.4505937099 * sp
  const bb = 0.0259040371 * lp + 0.7827717662 * mp - 0.808675766 * sp
  const h = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360
  return { l, c: Math.hypot(a, bb), h }
}

/** Three OKLCH colors for a seed, each in the lightness/chroma ranges and in gamut. */
export function seedPaletteOklch(seed: number): OklchColor[] {
  // Its own stream (seed mixed with a constant), apart from the layer and motion streams.
  const rng = mulberry32((seed ^ 0x2c1b3c6d) >>> 0)
  const between = (min: number, max: number): number => min + rng() * (max - min)
  const wrapHue = (hue: number): number => ((hue % 360) + 360) % 360

  const baseHue = between(0, 360)
  const step = between(ANALOGOUS_STEP.min, ANALOGOUS_STEP.max)
  const complementary = rng() < COMPLEMENTARY_SHARE
  const hues = complementary
    ? [baseHue, baseHue + step, baseHue + 180]
    : [baseHue - step, baseHue, baseHue + step]
  const chromaMid = (PALETTE_CHROMA.min + PALETTE_CHROMA.max) / 2

  return hues.map((hue, index) => {
    // The complementary accent is kept soft: lower half of the chroma range.
    const isAccent = complementary && index === 2
    const color: OklchColor = {
      l: between(PALETTE_LIGHTNESS.min, PALETTE_LIGHTNESS.max),
      c: isAccent
        ? between(PALETTE_CHROMA.min, chromaMid)
        : between(PALETTE_CHROMA.min, PALETTE_CHROMA.max),
      h: wrapHue(hue),
    }
    return intoGamut(color)
  })
}

/** The seed's palette as `#rrggbb` strings for the gradient generator. */
export function seedPalette(seed: number): string[] {
  return seedPaletteOklch(seed).map(oklchToHex)
}
