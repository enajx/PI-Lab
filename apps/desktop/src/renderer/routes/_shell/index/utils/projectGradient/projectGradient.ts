/**
 * Deterministic pastel gradient artwork for dashboard cards without thumbnails.
 *
 * Each project id independently selects a curated palette, one of twelve field
 * geometries, one of six transform-only motion families, and a calm phase/timing.
 * The combinations feel varied without runtime randomness or animated paint
 * properties: CSS rasterizes the three backgrounds, then only composites their
 * transforms. The same project therefore keeps the same artwork across launches.
 */

export type ProjectGradientShape =
  | "clouds"
  | "eddy"
  | "bloom"
  | "tidepool"
  | "ribbons"
  | "nebula"
  | "hourglass"
  | "corners"
  | "rings"
  | "folds"
  | "billow"
  | "saddle"

export type ProjectGradientMotion = "meander" | "turn" | "breathe" | "weave" | "orbit" | "rock"

export interface ProjectGradientAnimation {
  /** Full primary morph cycle in seconds. */
  durationSec: number
  /** Negative phase offset so visible cards do not move in sync. */
  delaySec: number
}

export interface ProjectGradientVariant {
  palette: string
  shape: ProjectGradientShape
  motion: ProjectGradientMotion
}

export interface ProjectGradient {
  /** Stationary, light pastel base behind the moving fields. */
  background: string
  /** Three independently transformed color-field images. */
  layerBackgrounds: readonly [string, string, string]
  /** Stationary inline SVG texture shared by every fallback card. */
  grainUrl: string
  /** Seeded visual families, exposed for the renderer's motion class. */
  variant: ProjectGradientVariant
  /** Seeded timing for the transform-only morph. */
  animation: ProjectGradientAnimation
}

interface HslColor {
  hue: number
  saturation: number
  lightness: number
}

interface PastelPalette {
  name: string
  colors: readonly [HslColor, HslColor, HslColor, HslColor]
  base: HslColor
}

type LayerBackgrounds = readonly [string, string, string]
type ShapeBuilder = (palette: PastelPalette) => LayerBackgrounds

const PALETTES: readonly [PastelPalette, ...PastelPalette[]] = [
  palette("sherbet", [346, 60, 86], [40, 68, 86], [286, 48, 88], [98, 54, 87], [24, 42, 90]),
  palette("sea-glass", [158, 50, 85], [196, 58, 86], [228, 46, 88], [34, 56, 88], [184, 36, 90]),
  palette("lilac-bloom", [286, 55, 86], [178, 48, 87], [54, 61, 88], [328, 53, 86], [278, 36, 90]),
  palette("candy-sky", [340, 68, 85], [193, 67, 85], [58, 72, 88], [266, 54, 87], [218, 38, 90]),
  palette("apricot-iris", [30, 70, 85], [276, 55, 86], [160, 49, 87], [5, 61, 86], [44, 39, 90]),
  palette(
    "watermelon-cloud",
    [6, 70, 84],
    [152, 55, 87],
    [334, 55, 87],
    [52, 63, 88],
    [18, 40, 90],
  ),
  palette(
    "butter-periwinkle",
    [56, 72, 88],
    [248, 58, 86],
    [190, 51, 87],
    [320, 52, 87],
    [52, 38, 90],
  ),
  palette(
    "pistachio-blush",
    [104, 58, 86],
    [336, 55, 87],
    [194, 52, 86],
    [42, 63, 88],
    [112, 36, 90],
  ),
  palette("coral-ice", [8, 70, 84], [208, 58, 86], [168, 52, 87], [298, 53, 87], [198, 36, 90]),
  palette(
    "mango-lavender",
    [42, 72, 85],
    [284, 57, 86],
    [154, 53, 87],
    [338, 57, 86],
    [48, 38, 90],
  ),
  palette("powder-orchid", [218, 54, 87], [304, 56, 86], [92, 57, 88], [18, 59, 87], [230, 34, 90]),
  palette("spring-sun", [132, 57, 86], [54, 70, 88], [188, 55, 86], [314, 52, 87], [122, 36, 90]),
]

const SHAPES: readonly [
  { name: ProjectGradientShape; build: ShapeBuilder },
  ...{ name: ProjectGradientShape; build: ShapeBuilder }[],
] = [
  { name: "clouds", build: clouds },
  { name: "eddy", build: eddy },
  { name: "bloom", build: bloom },
  { name: "tidepool", build: tidepool },
  { name: "ribbons", build: ribbons },
  { name: "nebula", build: nebula },
  { name: "hourglass", build: hourglass },
  { name: "corners", build: corners },
  { name: "rings", build: rings },
  { name: "folds", build: folds },
  { name: "billow", build: billow },
  { name: "saddle", build: saddle },
]

const MOTIONS: readonly [ProjectGradientMotion, ...ProjectGradientMotion[]] = [
  "meander",
  "turn",
  "breathe",
  "weave",
  "orbit",
  "rock",
]

/**
 * A cached, static noise tile. The larger grain than the previous diagnostic
 * version remains legible over pale colors without animating an SVG filter.
 */
const GRAIN_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.82' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.92'/%3E%3C/svg%3E"

function palette(
  name: string,
  first: readonly [number, number, number],
  second: readonly [number, number, number],
  third: readonly [number, number, number],
  fourth: readonly [number, number, number],
  base: readonly [number, number, number],
): PastelPalette {
  return {
    name,
    colors: [color(first), color(second), color(third), color(fourth)],
    base: color(base),
  }
}

function color(values: readonly [number, number, number]): HslColor {
  return { hue: values[0], saturation: values[1], lightness: values[2] }
}

function solid(value: HslColor): string {
  return `hsl(${value.hue} ${value.saturation}% ${value.lightness}%)`
}

function translucent(value: HslColor, alpha: number): string {
  return `hsl(${value.hue} ${value.saturation}% ${value.lightness}% / ${alpha})`
}

function seededItem<T>(items: readonly [T, ...T[]], seed: number): T {
  return items[seed % items.length] ?? items[0]
}

function clouds({ colors }: PastelPalette): LayerBackgrounds {
  const [a, b, c, d] = colors
  return [
    `radial-gradient(ellipse 64% 72% at 18% 24%, ${translucent(a, 0.94)} 0 34%, transparent 72%), radial-gradient(ellipse 68% 52% at 80% 28%, ${translucent(b, 0.9)} 0 36%, transparent 74%), radial-gradient(ellipse 76% 62% at 56% 82%, ${translucent(c, 0.9)} 0 36%, transparent 74%)`,
    `radial-gradient(ellipse 92% 42% at 45% 48%, ${translucent(d, 0.88)} 0 30%, transparent 70%), conic-gradient(from 120deg at 52% 55%, ${translucent(b, 0.74)}, ${translucent(a, 0.68)}, ${translucent(c, 0.76)}, ${translucent(b, 0.74)})`,
    `radial-gradient(ellipse 110% 45% at 50% 50%, ${translucent(a, 0.72)} 0 22%, transparent 68%)`,
  ]
}

function eddy({ colors }: PastelPalette): LayerBackgrounds {
  const [a, b, c, d] = colors
  return [
    `radial-gradient(ellipse 82% 68% at 24% 40%, ${solid(a)} 0 27%, ${translucent(b, 0.76)} 50%, transparent 76%), radial-gradient(ellipse 76% 72% at 80% 64%, ${solid(c)} 0 26%, ${translucent(d, 0.74)} 49%, transparent 75%), linear-gradient(145deg, ${solid(d)}, ${solid(b)})`,
    `radial-gradient(ellipse 108% 46% at 52% 46%, ${translucent(c, 0.76)} 0 28%, transparent 72%), radial-gradient(ellipse 48% 102% at 58% 58%, ${translucent(a, 0.68)} 0 26%, transparent 70%)`,
    `linear-gradient(128deg, transparent 18%, ${translucent(b, 0.68)} 46%, transparent 74%)`,
  ]
}

function bloom({ colors }: PastelPalette): LayerBackgrounds {
  const [a, b, c, d] = colors
  return [
    `radial-gradient(ellipse 88% 72% at 8% 22%, ${solid(a)} 0 25%, transparent 70%), radial-gradient(ellipse 82% 76% at 92% 18%, ${solid(b)} 0 24%, transparent 69%), radial-gradient(ellipse 90% 68% at 82% 92%, ${solid(c)} 0 25%, transparent 70%), radial-gradient(ellipse 84% 74% at 12% 86%, ${solid(d)} 0 24%, transparent 69%), linear-gradient(135deg, ${solid(d)}, ${solid(b)})`,
    `radial-gradient(ellipse 112% 48% at 48% 52%, ${translucent(c, 0.72)} 0 26%, transparent 72%), radial-gradient(ellipse 46% 108% at 54% 48%, ${translucent(a, 0.66)} 0 24%, transparent 70%)`,
    `radial-gradient(ellipse 72% 62% at 50% 52%, ${translucent(d, 0.7)} 0 22%, transparent 68%)`,
  ]
}

function tidepool({ colors }: PastelPalette): LayerBackgrounds {
  const [a, b, c, d] = colors
  return [
    `repeating-radial-gradient(ellipse 82% 60% at 22% 76%, ${solid(a)} 0 11%, ${solid(b)} 18% 28%, ${solid(c)} 35% 45%, ${solid(d)} 52% 63%, ${solid(a)} 70% 82%)`,
    `repeating-radial-gradient(ellipse at 78% 18%, transparent 0 16%, ${translucent(c, 0.7)} 24% 35%, transparent 43% 56%)`,
    `linear-gradient(128deg, transparent 25%, ${translucent(d, 0.68)} 48%, transparent 72%)`,
  ]
}

function ribbons({ colors }: PastelPalette): LayerBackgrounds {
  const [a, b, c, d] = colors
  return [
    `repeating-linear-gradient(104deg, ${solid(a)} 0 12%, ${solid(b)} 18% 29%, ${solid(c)} 36% 48%, ${solid(d)} 56% 69%, ${solid(a)} 78% 91%)`,
    `repeating-linear-gradient(26deg, transparent 0 16%, ${translucent(d, 0.74)} 24% 34%, transparent 43% 58%)`,
    `radial-gradient(ellipse 120% 34% at 42% 52%, ${translucent(b, 0.7)} 0 28%, transparent 64%)`,
  ]
}

function nebula({ colors }: PastelPalette): LayerBackgrounds {
  const [a, b, c, d] = colors
  return [
    `conic-gradient(from 210deg at 34% 62%, ${solid(a)}, ${translucent(d, 0.3)} 18%, ${solid(b)} 34%, ${solid(d)} 50%, ${translucent(c, 0.35)} 65%, ${solid(c)} 82%, ${solid(a)})`,
    `radial-gradient(ellipse 110% 26% at 46% 58%, ${translucent(c, 0.76)} 0 30%, transparent 70%), radial-gradient(ellipse 44% 82% at 67% 47%, ${translucent(a, 0.7)} 0 28%, transparent 68%)`,
    `conic-gradient(from 45deg at 55% 45%, transparent 0 20%, ${translucent(d, 0.7)} 34%, transparent 50% 72%, ${translucent(b, 0.72)} 86%, transparent)`,
  ]
}

function hourglass({ colors }: PastelPalette): LayerBackgrounds {
  const [a, b, c, d] = colors
  return [
    `conic-gradient(from 45deg at 50% 50%, ${solid(a)} 0 12.5%, ${solid(b)} 12.5% 25%, ${solid(c)} 25% 37.5%, ${solid(d)} 37.5% 50%, ${solid(a)} 50% 62.5%, ${solid(b)} 62.5% 75%, ${solid(c)} 75% 87.5%, ${solid(d)} 87.5%)`,
    `radial-gradient(ellipse 40% 94% at 50% 50%, transparent 0 18%, ${translucent(a, 0.74)} 44%, transparent 72%)`,
    `radial-gradient(ellipse 94% 30% at 50% 50%, ${translucent(d, 0.72)} 0 25%, transparent 68%)`,
  ]
}

function corners({ colors }: PastelPalette): LayerBackgrounds {
  const [a, b, c, d] = colors
  return [
    `radial-gradient(ellipse 76% 80% at 0% 0%, ${solid(a)} 0 32%, transparent 70%), radial-gradient(ellipse 76% 80% at 100% 0%, ${solid(b)} 0 32%, transparent 70%), radial-gradient(ellipse 76% 80% at 100% 100%, ${solid(c)} 0 32%, transparent 70%), radial-gradient(ellipse 76% 80% at 0% 100%, ${solid(d)} 0 32%, transparent 70%)`,
    `conic-gradient(from 90deg at 50% 50%, transparent, ${translucent(c, 0.68)}, transparent 28%, ${translucent(a, 0.68)}, transparent 62%, ${translucent(b, 0.68)}, transparent)`,
    `radial-gradient(circle at 50% 50%, ${translucent(d, 0.72)} 0 20%, transparent 64%)`,
  ]
}

function rings({ colors }: PastelPalette): LayerBackgrounds {
  const [a, b, c, d] = colors
  return [
    `repeating-radial-gradient(ellipse 70% 90% at 63% 48%, ${solid(a)} 0 9%, ${solid(b)} 14% 22%, ${solid(c)} 28% 37%, ${solid(d)} 43% 53%)`,
    `repeating-radial-gradient(circle at 30% 65%, transparent 0 13%, ${translucent(b, 0.72)} 20% 28%, transparent 35% 48%)`,
    `conic-gradient(from 180deg at 50% 50%, ${translucent(d, 0.72)}, transparent 35%, ${translucent(a, 0.72)}, transparent 70%, ${translucent(d, 0.72)})`,
  ]
}

function folds({ colors }: PastelPalette): LayerBackgrounds {
  const [a, b, c, d] = colors
  return [
    `linear-gradient(28deg, transparent 0 18%, ${solid(a)} 29% 42%, transparent 54%), linear-gradient(142deg, ${solid(b)} 0 18%, transparent 35% 55%, ${solid(c)} 74% 88%, ${solid(d)})`,
    `linear-gradient(74deg, transparent 18%, ${translucent(d, 0.76)} 39%, transparent 58%), linear-gradient(196deg, transparent 23%, ${translucent(b, 0.72)} 49%, transparent 71%)`,
    `conic-gradient(from 135deg at 48% 52%, transparent, ${translucent(a, 0.68)}, transparent 26%, ${translucent(c, 0.68)}, transparent 68%, ${translucent(b, 0.68)}, transparent)`,
  ]
}

function billow({ colors }: PastelPalette): LayerBackgrounds {
  const [a, b, c, d] = colors
  return [
    `radial-gradient(ellipse 86% 38% at 45% 18%, ${solid(a)} 0 36%, transparent 70%), radial-gradient(ellipse 44% 90% at 82% 58%, ${solid(b)} 0 36%, transparent 70%), radial-gradient(ellipse 90% 42% at 43% 88%, ${solid(c)} 0 36%, transparent 70%), radial-gradient(ellipse 40% 86% at 12% 48%, ${solid(d)} 0 36%, transparent 70%)`,
    `conic-gradient(from 0deg at 50% 50%, ${translucent(a, 0.68)}, transparent 20%, ${translucent(b, 0.68)}, transparent 45%, ${translucent(c, 0.68)}, transparent 70%, ${translucent(d, 0.68)})`,
    `radial-gradient(circle at 50% 50%, transparent 0 16%, ${translucent(b, 0.72)} 36%, transparent 66%)`,
  ]
}

function saddle({ colors }: PastelPalette): LayerBackgrounds {
  const [a, b, c, d] = colors
  return [
    `conic-gradient(from 45deg at 50% 50%, ${solid(a)} 0 25%, ${solid(b)} 25% 50%, ${solid(c)} 50% 75%, ${solid(d)} 75%)`,
    `radial-gradient(ellipse 36% 100% at 50% 50%, transparent 0 25%, ${translucent(a, 0.72)} 48%, transparent 74%), radial-gradient(ellipse 100% 36% at 50% 50%, transparent 0 25%, ${translucent(c, 0.72)} 48%, transparent 74%)`,
    `conic-gradient(from 225deg at 50% 50%, transparent, ${translucent(d, 0.7)}, transparent 25%, ${translucent(b, 0.7)}, transparent 55%, ${translucent(a, 0.7)}, transparent)`,
  ]
}

/** Stable 32-bit FNV-1a hash; deterministic and dependency-free. */
function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash >>> 0
}

export function projectGradient(projectId: string): ProjectGradient {
  const paletteSeed = hashString(`${projectId}:palette`)
  const shapeSeed = hashString(`${projectId}:shape`)
  const motionSeed = hashString(`${projectId}:motion`)
  const timingSeed = hashString(`${projectId}:timing`)

  const selectedPalette = seededItem(PALETTES, paletteSeed)
  const selectedShape = seededItem(SHAPES, shapeSeed)
  const motion = seededItem(MOTIONS, motionSeed)
  const angle = hashString(`${projectId}:angle`) % 180
  const [first, second, , fourth] = selectedPalette.colors
  const background = `linear-gradient(${angle}deg, ${solid(selectedPalette.base)} 0%, ${solid(first)} 48%, ${solid(second)} 72%, ${solid(fourth)} 100%)`

  const durationSec = 8 + (timingSeed % 5)
  const delaySec = -((timingSeed >>> 8) % (durationSec * 10)) / 10

  return {
    background,
    layerBackgrounds: selectedShape.build(selectedPalette),
    grainUrl: GRAIN_SVG,
    variant: {
      palette: selectedPalette.name,
      shape: selectedShape.name,
      motion,
    },
    animation: { durationSec, delaySec },
  }
}
