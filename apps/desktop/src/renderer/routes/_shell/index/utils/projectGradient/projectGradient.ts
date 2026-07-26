/**
 * Noisy-gradient artwork for dashboard cards without thumbnails.
 *
 * The look comes from the shared, framework-agnostic generator in
 * `@pi-lab/ui` (ported from the `gradient-patterns` reference): translucent
 * rectangles melted together by a huge `feGaussianBlur`, plus `feTurbulence`
 * grain. Those SVG filters are expensive to compute, so we **bake each layer to a
 * `data:` URI once** (memoized by seed+palette) and hand the raster to CSS as a
 * `background-image`. The card then drifts three stacked layers with
 * compositor-only `transform`s (see `globals.css` `.project-gradient-*`), so the
 * filters never re-rasterize per frame — the drift is nearly free.
 *
 * A project's gradient is fully described by a `{ seed, palette }` pair, persisted
 * on the project row (`@pi-lab/local-db` `ProjectGradient`). The same pair always
 * reproduces the same artwork, which is what keeps a project's gradient identical
 * across app restarts. `seed` also deterministically picks the drift motion and
 * timing, so the whole card is a pure function of the stored pair.
 */

import { buildGrainSVG, buildLayerSVG, generateConfig, mulberry32, toDataUri } from "@pi-lab/ui"

export type ProjectGradientMotion = "meander" | "turn" | "breathe" | "weave" | "orbit" | "rock"

export interface ProjectGradientAnimation {
  /** Full primary drift cycle in seconds. */
  durationSec: number
  /** Negative phase offset so visible cards do not drift in sync. */
  delaySec: number
}

export interface ProjectGradientVariant {
  /** Transform-only motion family, exposed for the renderer's motion class. */
  motion: ProjectGradientMotion
}

export interface ProjectGradientArtwork {
  /** Opaque base fill behind the translucent layers ("#FFFFFF" or "#000000"). */
  baseColor: string
  /** A soft, stationary color tint drawn over the base (CSS `background-image`). */
  background: string
  /** Three independently drifted, baked color-field images (`url("data:…")`). */
  layerBackgrounds: readonly [string, string, string]
  /** Stationary, baked turbulence grain shared by every fallback card. */
  grainUrl: string
  /** Seeded visual family, for the renderer's motion class + debug attributes. */
  variant: ProjectGradientVariant
  /** Seeded timing for the transform-only drift. */
  animation: ProjectGradientAnimation
}

const MOTIONS: readonly [ProjectGradientMotion, ...ProjectGradientMotion[]] = [
  "meander",
  "turn",
  "breathe",
  "weave",
  "orbit",
  "rock",
]

/** Stable 32-bit FNV-1a hash; deterministic and dependency-free. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash >>> 0
}

/** Fold a `#rgb`/`#rrggbb` hex to an `rgba()` string at the given alpha. */
function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "")
  const full =
    value.length === 3
      ? value
          .split("")
          .map((char) => char + char)
          .join("")
      : value
  const red = Number.parseInt(full.slice(0, 2), 16)
  const green = Number.parseInt(full.slice(2, 4), 16)
  const blue = Number.parseInt(full.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

/**
 * Memoize by seed+palette: the artwork is immutable, so a card that re-renders
 * (e.g. on an activity poll) reuses the already-baked SVGs instead of re-encoding
 * three filtered documents. Keyed by project count, so the map stays tiny.
 */
const cache = new Map<string, ProjectGradientArtwork>()

/**
 * Build the card artwork for a persisted `{ seed, palette }` pair. Pure and
 * deterministic: identical inputs yield an identical (and cached) result.
 */
export function projectGradient(seed: number, palette: readonly string[]): ProjectGradientArtwork {
  const key = `${seed}:${palette.join(",")}`
  const cached = cache.get(key)
  if (cached) return cached

  // A dedicated stream for motion/timing so it never shifts if layer seeding changes.
  const pick = mulberry32(seed >>> 0)
  const motion = MOTIONS[Math.floor(pick() * MOTIONS.length)] ?? MOTIONS[0]
  // A brisker cadence keeps active-project drift legible at card scale without
  // changing the compositor-only implementation.
  const durationSec = 6 + Math.floor(pick() * 4) // 6..9
  // A negative phase on a 0.1s grid, strictly within one cycle: (-dur, 0].
  const delaySec = -(Math.floor(pick() * durationSec * 10) / 10)

  // Three distinct-but-related fields: same palette, well-separated seeds so the
  // stacked layers differ enough that independent drift reads as a morph. The first
  // config also supplies the shared base tint that sits behind all three.
  const baseConfig = generateConfig({ seed: seed >>> 0, palette })
  const configs = [
    baseConfig,
    generateConfig({ seed: (seed ^ 0x9e3779b9) >>> 0, palette }),
    generateConfig({ seed: (seed ^ 0x85ebca77) >>> 0, palette }),
  ]
  const [layerA, layerB, layerC] = configs.map(
    (config) => `url("${toDataUri(buildLayerSVG(config))}")`,
  )
  const layerBackgrounds: readonly [string, string, string] = [
    layerA ?? "",
    layerB ?? "",
    layerC ?? "",
  ]

  const tint = hexToRgba(baseConfig.background.color, baseConfig.background.opacity)

  const artwork: ProjectGradientArtwork = {
    baseColor: baseConfig.lightDarkMode,
    background: `linear-gradient(0deg, ${tint}, ${tint})`,
    layerBackgrounds,
    grainUrl: toDataUri(buildGrainSVG()),
    variant: { motion },
    animation: { durationSec, delaySec },
  }
  cache.set(key, artwork)
  return artwork
}
