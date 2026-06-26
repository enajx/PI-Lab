/**
 * A deterministic "smooth grainy gradient" for a project card's header when it
 * has no thumbnail (md/02 — "Dashboard & project cards": fallback = a random
 * smooth grainy gradient). "Random" but **stable per project**: the colors are
 * seeded from the project id so a card keeps the same look across reloads, while
 * different projects get visibly different gradients.
 *
 * Pure and self-contained: returns a CSS `background` value (a soft three-stop
 * linear gradient between two hues), an inline SVG noise `data:` URL for the
 * grain overlay, and the seeded parameters for a slow transform-only morph (so
 * the no-thumbnail header feels subtly alive). No randomness, no I/O — the same
 * id always yields the same gradient and the same animation timing, which keeps
 * the dashboard deterministic for snapshot/E2E.
 */

export interface ProjectGradientAnimation {
  /** Full morph cycle length in seconds (slow; varies per project). */
  durationSec: number
  /**
   * Negative phase offset in seconds, so cards starting at the same time are not
   * synchronized (each appears mid-cycle). Always `<= 0`.
   */
  delaySec: number
}

export interface ProjectGradient {
  /** CSS `background` value: the smooth multi-stop gradient. */
  background: string
  /** A `data:` URL of an SVG noise tile, layered over the gradient for grain. */
  grainUrl: string
  /** Seeded timing for the transform-only morph animation. */
  animation: ProjectGradientAnimation
}

/** A small, stable 32-bit hash of a string (FNV-1a). Deterministic, no deps. */
function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    // Multiply by the FNV prime via shifts to stay in 32-bit integer math.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash >>> 0
}

/** A muted, card-friendly HSL color derived from a hue seed. */
function hsl(hue: number, saturation: number, lightness: number): string {
  return `hsl(${hue} ${saturation}% ${lightness}%)`
}

/**
 * The grain overlay: a tiny SVG that draws fractal noise, base64-free (plain
 * `utf8` data URL) so it stays readable and needs no encoding step. Tuned for a
 * retro film-grain look — a high `baseFrequency` gives fine, dense grain and the
 * extra octaves add fibrous detail; the strong rect opacity lets the speckle read
 * clearly once layered (the overlay element controls the final intensity/blend).
 */
const GRAIN_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.6' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.85'/%3E%3C/svg%3E"

export function projectGradient(projectId: string): ProjectGradient {
  const seed = hashString(projectId)
  // Two related hues (a gentle analogous sweep) plus an angle, all from the seed.
  const baseHue = seed % 360
  const secondHue = (baseHue + 40 + (seed % 60)) % 360
  const angle = seed % 180

  const background = `linear-gradient(${angle}deg, ${hsl(baseHue, 45, 30)} 0%, ${hsl(
    secondHue,
    50,
    42,
  )} 55%, ${hsl(baseHue, 40, 22)} 100%)`

  // Transform-only morph timing, derived from the SAME seed as the palette so the
  // animation stays deterministic. A slow ~28–52s cycle, started at a negative
  // (mid-cycle) phase offset so a grid of cards never beats in lockstep.
  const durationSec = 28 + (seed % 25)
  const delaySec = -(seed % Math.round(durationSec))

  return { background, grainUrl: GRAIN_SVG, animation: { durationSec, delaySec } }
}
