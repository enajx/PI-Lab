import { readFileSync } from "node:fs"
import type { NativeImage, nativeImage } from "electron"
import type { AppIconPalette, AppIconSelection } from "../../shared/appIcon"

type Rgb = readonly [number, number, number]

interface Gradients {
  sourceGradient: Uint8Array
  targetGradient: Uint8Array
}

interface PaletteFile {
  palettes: Record<string, string[]>
}

const MAGMA_STOPS: readonly [number, Rgb][] = [
  [0, [0, 0, 4]],
  [0.2, [59, 15, 112]],
  [0.4, [140, 41, 129]],
  [0.6, [222, 73, 104]],
  [0.8, [254, 159, 109]],
  [1, [252, 253, 191]],
]

let loadedPalettePath: string | null = null
let loadedPalettes: PaletteFile | null = null

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value))
}

function colorBetween(first: Rgb, second: Rgb, fraction: number): Rgb {
  return [
    Math.round(first[0] + (second[0] - first[0]) * fraction),
    Math.round(first[1] + (second[1] - first[1]) * fraction),
    Math.round(first[2] + (second[2] - first[2]) * fraction),
  ]
}

function magmaColor(position: number): Rgb {
  for (let index = 1; index < MAGMA_STOPS.length; index += 1) {
    const next = MAGMA_STOPS[index]
    const previous = MAGMA_STOPS[index - 1]
    if (next && previous && position <= next[0]) {
      return colorBetween(previous[1], next[1], (position - previous[0]) / (next[0] - previous[0]))
    }
  }
  return MAGMA_STOPS[MAGMA_STOPS.length - 1]?.[1] ?? [252, 253, 191]
}

function sampleColor(samples: readonly string[], position: number): Rgb {
  const index = position * (samples.length - 1)
  const left = Math.floor(index)
  const right = Math.min(samples.length - 1, left + 1)
  const parse = (value: string | undefined): Rgb => {
    if (!value || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error("Invalid app icon palette")
    return [
      Number.parseInt(value.slice(1, 3), 16),
      Number.parseInt(value.slice(3, 5), 16),
      Number.parseInt(value.slice(5, 7), 16),
    ]
  }
  return colorBetween(parse(samples[left]), parse(samples[right]), index - left)
}

function loadPalette(palettePath: string, palette: AppIconPalette): readonly string[] {
  if (loadedPalettePath !== palettePath) {
    loadedPalettes = JSON.parse(readFileSync(palettePath, "utf8")) as PaletteFile
    loadedPalettePath = palettePath
  }
  const samples = loadedPalettes?.palettes[palette]
  if (samples?.length !== 256) throw new Error(`App icon palette unavailable: ${palette}`)
  return samples
}

function gradients(
  width: number,
  samples: readonly string[],
  reversed: boolean,
  limited: boolean,
): Gradients {
  const sourceGradient = new Uint8Array(width * 3)
  const targetGradient = new Uint8Array(width * 3)
  for (let x = 0; x < width; x += 1) {
    const normalized = clamp((x - width / 16) / (width * (14 / 16)), 0, 1)
    const directed = reversed ? 1 - normalized : normalized
    const position = limited ? 0.1 + directed * 0.8 : directed
    const source = magmaColor(position)
    const target = sampleColor(samples, position)
    sourceGradient.set(source, x * 3)
    targetGradient.set(target, x * 3)
  }
  return { sourceGradient, targetGradient }
}

/** Replace Beta's magma tile with the selected Stable palette, retaining its white symbol. */
export function recolorBetaDockBitmap(
  bitmap: Buffer,
  width: number,
  height: number,
  colors: Gradients,
): Buffer {
  if (
    bitmap.length !== width * height * 4 ||
    colors.sourceGradient.length !== width * 3 ||
    colors.targetGradient.length !== width * 3
  ) {
    throw new Error("Invalid Beta Dock icon dimensions")
  }
  const output = Buffer.from(bitmap)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const alpha = bitmap[offset + 3] ?? 0
      if (alpha === 0) continue
      const colorOffset = x * 3
      const base: Rgb = [
        colors.sourceGradient[colorOffset] ?? 0,
        colors.sourceGradient[colorOffset + 1] ?? 0,
        colors.sourceGradient[colorOffset + 2] ?? 0,
      ]
      const target: Rgb = [
        colors.targetGradient[colorOffset] ?? 0,
        colors.targetGradient[colorOffset + 1] ?? 0,
        colors.targetGradient[colorOffset + 2] ?? 0,
      ]
      const source: Rgb = [
        Math.min(255, Math.round(((bitmap[offset + 2] ?? 0) * 255) / alpha)),
        Math.min(255, Math.round(((bitmap[offset + 1] ?? 0) * 255) / alpha)),
        Math.min(255, Math.round(((bitmap[offset] ?? 0) * 255) / alpha)),
      ]
      const isOutline =
        source[0] < base[0] - 4 || source[1] < base[1] - 4 || source[2] < base[2] - 4
      let red: number
      let green: number
      let blue: number
      if (isOutline) {
        const sourceLight = source[0] * 0.2126 + source[1] * 0.7152 + source[2] * 0.0722
        const baseLight = base[0] * 0.2126 + base[1] * 0.7152 + base[2] * 0.0722
        const shade = clamp(sourceLight / Math.max(1, baseLight), 0, 1)
        red = Math.round(target[0] * shade)
        green = Math.round(target[1] * shade)
        blue = Math.round(target[2] * shade)
      } else {
        const rise: Rgb = [255 - base[0], 255 - base[1], 255 - base[2]]
        const numerator =
          (source[0] - base[0]) * rise[0] +
          (source[1] - base[1]) * rise[1] +
          (source[2] - base[2]) * rise[2]
        const denominator = rise[0] ** 2 + rise[1] ** 2 + rise[2] ** 2
        const white = clamp(numerator / Math.max(1, denominator), 0, 1)
        red = Math.round(target[0] * (1 - white) + 255 * white)
        green = Math.round(target[1] * (1 - white) + 255 * white)
        blue = Math.round(target[2] * (1 - white) + 255 * white)
      }
      output[offset] = Math.round((blue * alpha) / 255)
      output[offset + 1] = Math.round((green * alpha) / 255)
      output[offset + 2] = Math.round((red * alpha) / 255)
    }
  }
  return output
}

/** Build a public Beta Dock image from the shared icon choice without touching the signed app. */
export function createBetaDockIcon(
  selectedPath: string,
  selection: AppIconSelection,
  palettePath: string,
  imageFactory: typeof nativeImage,
): NativeImage {
  const palette = selection.family === "joyplot" ? selection.joyplotPalette : selection.piPalette
  const source = imageFactory.createFromPath(selectedPath)
  if (source.isEmpty()) throw new Error(`Beta app icon unavailable: ${selectedPath}`)
  if (palette === "magma") return source
  const size = source.getSize()
  const reversed = selection.family === "joyplot" ? selection.joyplotReverse : selection.piReverse
  const limited =
    selection.family === "joyplot"
      ? selection.joyplotLimitVisibleRange
      : selection.piLimitVisibleRange
  const colors = gradients(size.width, loadPalette(palettePath, palette), reversed, limited)
  const bitmap = recolorBetaDockBitmap(source.toBitmap(), size.width, size.height, colors)
  return imageFactory.createFromBitmap(bitmap, size)
}
