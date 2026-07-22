/**
 * Sample the current app theme's saturated colors for a project-card gradient.
 *
 * The gradient generator wants a handful of concrete fill colors; the app theme
 * exposes its accents as CSS custom properties (which may be `oklch`, `hsl`, or
 * hex, depending on the theme). We resolve each token to an sRGB hex the SVG
 * generator can drop straight into a `fill` by letting the browser compute it:
 * a detached probe element inherits the `:root`/themed custom properties, and its
 * computed `color` comes back as `rgb(...)`, which we fold to `#rrggbb`.
 *
 * The result is captured once at generation time and persisted per project, so a
 * later theme switch never alters a gradient that already exists (the user's
 * "keep whatever was used for the project already").
 */

/** The theme's accent tokens, in the order they seed the gradient palette. */
const THEME_GRADIENT_TOKENS = ["--accent-brand", "--primary", "--destructive"] as const

/** Fallback if a token can't be resolved (jsdom, missing var) — the lib's vivid base. */
const FALLBACK_PALETTE = ["#FFC700", "#1BC47D", "#f2371f"] as const

function toHex(channel: number): string {
  return Math.max(0, Math.min(255, Math.round(channel)))
    .toString(16)
    .padStart(2, "0")
}

/** Resolve a CSS color expression (incl. `var(--x)`) to `#rrggbb`, or null. */
function resolveToHex(cssColor: string): string | null {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return null
  const probe = document.createElement("span")
  probe.style.color = cssColor
  probe.style.display = "none"
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  const match = computed.match(/rgba?\(([^)]+)\)/)
  if (!match?.[1]) return null
  const [red, green, blue] = match[1].split(",").map((value) => Number.parseFloat(value))
  if (red === undefined || green === undefined || blue === undefined) return null
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`
}

/**
 * Read the active theme's `brand`/`primary`/`destructive` as hex. Returns at least
 * one color (falls back to the generator's vivid palette when nothing resolves),
 * so callers always have a usable, non-empty palette.
 */
export function sampleThemePalette(): string[] {
  const sampled = THEME_GRADIENT_TOKENS.map((token) => resolveToHex(`var(${token})`)).filter(
    (color): color is string => color !== null,
  )
  return sampled.length > 0 ? sampled : [...FALLBACK_PALETTE]
}
