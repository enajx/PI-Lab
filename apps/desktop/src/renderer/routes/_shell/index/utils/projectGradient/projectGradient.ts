/**
 * A deterministic "smooth grainy gradient" for a project card's header when it
 * has no thumbnail (md/02 — "Dashboard & project cards": fallback = a random
 * smooth grainy gradient). "Random" but **stable per project**: the colors are
 * seeded from the project id so a card keeps the same look across reloads, while
 * different projects get visibly different gradients.
 *
 * Pure and self-contained: returns a CSS `background` value (a soft three-stop
 * linear gradient between two hues) and an inline SVG noise `data:` URL for the
 * grain overlay. No randomness, no I/O — the same id always yields the same
 * gradient, which keeps the dashboard deterministic for snapshot/E2E.
 */

export interface ProjectGradient {
  /** CSS `background` value: the smooth multi-stop gradient. */
  background: string
  /** A `data:` URL of an SVG noise tile, layered over the gradient for grain. */
  grainUrl: string
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
 * `utf8` data URL) so it stays readable and needs no encoding step. Low opacity
 * keeps it "subtle" per the spec.
 */
const GRAIN_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E"

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

  return { background, grainUrl: GRAIN_SVG }
}
