/**
 * Gradient Patterns generator — the "noisy gradient" look reverse-engineered from
 * noisygradients.com, ported from the standalone `gradient-patterns/` reference
 * into a typed, framework-agnostic core.
 *
 * Config generation is fully separated from rendering:
 *   generateConfig()   -> plain data object (no DOM, no SVG)
 *   buildSVG(config)   -> full single SVG string (opaque base + shapes + grain)
 *   buildLayerSVG(cfg) -> transparent, shapes-only SVG for stacking/animating
 *
 * The "gradient" look is NOT SVG gradient stops — it is a handful of large
 * translucent rectangles melted together by an enormous `feGaussianBlur`
 * (stdDeviation `DEFAULT_BLUR` on a 1600px canvas). Drop the blur toward 0 and it
 * degrades back into hard rectangles: the blur is the whole trick. Grain comes
 * from `feTurbulence`, not from an image.
 */

/** Default palette used by the original site. Override via `options.palette`. */
export const PALETTE: readonly [string, ...string[]] = [
  "#FFC700",
  "#1BC47D",
  "#f2371f",
  "#18A0FB",
  "#907CFF",
  "#00c5df",
  "#EE46D3",
]

/**
 * The tunable aesthetic knobs, matching the playground's controls. These are the
 * "preserved" dials from the reference: change them here (or eyeball them live in
 * the playground) to reshape how every gradient looks.
 */
export const GRADIENT_PATTERN_DEFAULTS = {
  /** feGaussianBlur stdDeviation on the 1600px canvas — the whole smoothing trick. */
  blur: 250,
  /** feTurbulence baseFrequency for the grain. */
  baseFrequency: 0.7,
  /** feTurbulence octaves for the grain. */
  numOctaves: 3,
  /** Whether the turbulence grain layer is applied at all. */
  noise: true,
} as const

export interface Stop {
  color: string
  opacity: number
}

export interface ShapeGradient {
  type?: string
  x1?: number
  y1?: number
  x2?: number
  y2?: number
  stops?: Stop[]
}

export interface Shape {
  shape: "rectangle"
  x: number
  y: number
  width: number
  height: number
  fill: string
  fillType: "solid" | "linear_gradient"
  opacity: number
  gradient: ShapeGradient
}

export interface NoiseConfig {
  isNoise: boolean
  baseFrequency: number
  numOctaves: number
  value: number
  seed: number
}

export interface GradientColor {
  type: string
  id: number
  value: string
}

export interface GradientConfig {
  background: { color: string; opacity: number }
  shapes: Shape[]
  /** Base fill behind the shapes, "#FFFFFF" or "#000000". */
  lightDarkMode: string
  allColors: GradientColor[]
  noiseConfig: NoiseConfig
}

export interface GenerateOptions {
  palette?: readonly string[]
  rng?: () => number
  seed?: number
}

/**
 * mulberry32 — a tiny, fast, seedable PRNG. The same seed always produces the same
 * sequence, which is what makes a gradient reproducible ("this project always gets
 * this gradient").
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Resolve an RNG: explicit `rng` wins, else derive from `seed`, else Math.random. */
function resolveRng({ rng, seed }: { rng?: () => number; seed?: number }): () => number {
  if (typeof rng === "function") return rng
  if (typeof seed === "number") return mulberry32(seed)
  return Math.random
}

interface Rng {
  int: (min: number, max: number) => number
  float: (low: number, high: number) => number
  pick: <T>(arr: readonly T[]) => T
}

/** Random helpers over an injectable base RNG (floats in [0, 1)). */
function makeRng(rng: () => number): Rng {
  return {
    int: (min, max) => Math.floor(rng() * (max - min + 1) + min),
    float: (low, high) => rng() * (low - high) + high,
    pick: (arr) => arr[Math.floor(rng() * arr.length)] as (typeof arr)[number],
  }
}

/**
 * Generate one shape. The original hardcodes `fillType: "solid"`, so the gradient
 * branch is effectively dead in the default path — kept for fidelity in case true
 * gradient stops are ever wanted.
 */
export function generateShape(
  id: number,
  { palette = PALETTE, rng }: { palette?: readonly string[]; rng: () => number },
): { shape: Shape; color: GradientColor } {
  const r = makeRng(rng)
  const x = r.int(0, 800)
  const y = r.int(0, 800)
  const w = r.int(800, 1280)
  const h = r.int(800, 1280)
  const fill = r.pick(palette)

  const shape: Shape = {
    shape: "rectangle",
    x,
    y,
    width: w,
    height: h,
    fill,
    fillType: "solid",
    opacity: r.float(0.5, 1),
    gradient: {},
  }

  return { shape, color: { type: "shape", id: id || 0, value: fill } }
}

/**
 * Generate a full gradient config (pure data — no SVG, no DOM). Pass `seed` for
 * reproducible output, or your own `rng`.
 */
export function generateConfig({
  palette = PALETTE,
  rng,
  seed,
}: GenerateOptions = {}): GradientConfig {
  // Resolve ONCE so the same stateful rng advances across every draw below.
  const baseRng = resolveRng({ rng, seed })
  const r = makeRng(baseRng)
  const bgOpacity = r.float(0.1, 0.5)
  const bgColor = r.pick(palette)
  const lightDarkMode = r.int(0, 10) % 2 ? "#FFFFFF" : "#000000"
  const n = r.pick([1, 2, 3, 4, 5, 6])

  const shapes: Shape[] = []
  const allColors: GradientColor[] = []
  for (let u = 0; u < n; u++) {
    const { shape, color } = generateShape(u, { palette, rng: baseRng })
    shapes.push(shape)
    allColors.push(color)
  }

  return {
    background: { color: bgColor, opacity: bgOpacity },
    shapes,
    lightDarkMode,
    allColors,
    // Original hardcodes these on the spacebar path. seed:0 => STATIC noise.
    noiseConfig: {
      isNoise: GRADIENT_PATTERN_DEFAULTS.noise,
      baseFrequency: GRADIENT_PATTERN_DEFAULTS.baseFrequency,
      numOctaves: GRADIENT_PATTERN_DEFAULTS.numOctaves,
      value: 1.5,
      seed: 0,
    },
  }
}

/** The translucent, blurred rectangles that make up a gradient's color field. */
function shapeRects(shapes: readonly Shape[]): string {
  return shapes
    .map(
      (s) =>
        `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" fill="${s.fill}" fill-opacity="${s.opacity}"/>`,
    )
    .join("\n      ")
}

/** The shared filter defs (blur + turbulence + clip) used by both SVG builders. */
function filterDefs(nc: NoiseConfig, blur: number): string {
  return `<defs>
      <filter id="feTurb02" filterUnits="objectBoundingBox" x="0%" y="0%" width="100%" height="100%">
        <feTurbulence baseFrequency="${nc.baseFrequency}" numOctaves="${nc.numOctaves}" seed="${nc.seed}" result="out1"/>
        <feComposite in="out1" in2="SourceGraphic" operator="in" result="out2"/>
        <feBlend in="SourceGraphic" in2="out2" mode="overlay" result="out3"/>
      </filter>
      <filter id="foregroundBlur" x="0" y="0" width="1600" height="1600" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
        <feFlood flood-opacity="0" result="BackgroundImageFix"/>
        <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
        <feGaussianBlur stdDeviation="${blur}" result="effect1_foregroundBlur"/>
      </filter>
      <clipPath id="clip0"><rect width="1600" height="1600" fill="white"/></clipPath>
    </defs>`
}

/**
 * Build the full single SVG (opaque base + background tint + blurred shapes +
 * turbulence grain). This is the faithful reference look — what the playground
 * renders and what a standalone background would use.
 */
export function buildSVG(
  cfg: GradientConfig,
  { blur = GRADIENT_PATTERN_DEFAULTS.blur }: { blur?: number } = {},
): string {
  const { background: bg, shapes, lightDarkMode, noiseConfig: nc } = cfg
  const noiseLayer = nc.isNoise
    ? `<g style="mix-blend-mode:overlay">
      <rect x="0" y="0" width="1600" height="1600" style="fill:gray; stroke:transparent; filter:url(#feTurb02)"/>
    </g>`
    : ""

  return `<svg viewBox="0 0 1600 1600" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <rect width="1600" height="1600" fill="${lightDarkMode}"/>
    <rect width="1600" height="1600" fill="${bg.color}" fill-opacity="${bg.opacity}"/>
    <g clip-path="url(#clip0)"><g filter="url(#foregroundBlur)">
      ${shapeRects(shapes)}
    </g></g>
    ${noiseLayer}
    ${filterDefs(nc, blur)}
  </svg>`
}

/**
 * Build a transparent, shapes-only SVG: just the blurred translucent color field
 * on a clear background, with no opaque base and no grain. This is the per-layer
 * building block for the dashboard cards — several of these are stacked and
 * drifted independently to make the color field appear to morph, while a single
 * base tint and a single grain overlay live outside the animated layers.
 */
export function buildLayerSVG(
  cfg: GradientConfig,
  { blur = GRADIENT_PATTERN_DEFAULTS.blur }: { blur?: number } = {},
): string {
  return `<svg viewBox="0 0 1600 1600" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g clip-path="url(#clip0)"><g filter="url(#foregroundBlur)">
      ${shapeRects(cfg.shapes)}
    </g></g>
    <defs>
      <filter id="foregroundBlur" x="0" y="0" width="1600" height="1600" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
        <feFlood flood-opacity="0" result="BackgroundImageFix"/>
        <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
        <feGaussianBlur stdDeviation="${blur}" result="effect1_foregroundBlur"/>
      </filter>
      <clipPath id="clip0"><rect width="1600" height="1600" fill="white"/></clipPath>
    </defs>
  </svg>`
}

/** Build a standalone turbulence grain tile (desaturated fractal noise). */
export function buildGrainSVG({
  baseFrequency = GRADIENT_PATTERN_DEFAULTS.baseFrequency,
  numOctaves = GRADIENT_PATTERN_DEFAULTS.numOctaves,
}: {
  baseFrequency?: number
  numOctaves?: number
} = {}): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="${baseFrequency}" numOctaves="${numOctaves}" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#n)" opacity="0.9"/></svg>`
}

/** Wrap SVG markup as an inline `data:image/svg+xml` URI, escaped for CSS `url()`. */
export function toDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
