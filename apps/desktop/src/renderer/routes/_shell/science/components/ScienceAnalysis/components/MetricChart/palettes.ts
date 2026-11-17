/**
 * Color maps for Analysis charts: PI Lab's default and the usual matplotlib
 * ones. Qualitative maps repeat their colors; sequential maps (viridis and
 * friends) are sampled evenly across the series, from first to last.
 */

export interface Palette {
  id: string
  label: string
  colors: string[]
  sequential: boolean
}

/** The id of PI Lab's own colors, the default. */
export const DEFAULT_PALETTE = "default"

const hex = (list: string): string[] => list.split(" ").map((value) => `#${value}`)

export const PALETTES: Palette[] = [
  {
    id: DEFAULT_PALETTE,
    label: "PI Lab",
    sequential: false,
    colors: [
      "oklch(0.65 0.18 250)",
      "oklch(0.65 0.18 30)",
      "oklch(0.65 0.18 140)",
      "oklch(0.65 0.18 300)",
      "oklch(0.65 0.18 60)",
      "oklch(0.65 0.18 180)",
      "oklch(0.65 0.18 0)",
      "oklch(0.65 0.18 210)",
    ],
  },
  {
    id: "tab10",
    label: "tab10",
    sequential: false,
    colors: hex("1f77b4 ff7f0e 2ca02c d62728 9467bd 8c564b e377c2 7f7f7f bcbd22 17becf"),
  },
  {
    id: "tab20",
    label: "tab20",
    sequential: false,
    colors: hex(
      "1f77b4 aec7e8 ff7f0e ffbb78 2ca02c 98df8a d62728 ff9896 9467bd c5b0d5 8c564b c49c94 e377c2 f7b6d2 7f7f7f c7c7c7 bcbd22 dbdb8d 17becf 9edae5",
    ),
  },
  {
    id: "Set1",
    label: "Set1",
    sequential: false,
    colors: hex("e41a1c 377eb8 4daf4a 984ea3 ff7f00 ffff33 a65628 f781bf 999999"),
  },
  {
    id: "Set2",
    label: "Set2",
    sequential: false,
    colors: hex("66c2a5 fc8d62 8da0cb e78ac3 a6d854 ffd92f e5c494 b3b3b3"),
  },
  {
    id: "Set3",
    label: "Set3",
    sequential: false,
    colors: hex(
      "8dd3c7 ffffb3 bebada fb8072 80b1d3 fdb462 b3de69 fccde5 d9d9d9 bc80bd ccebc5 ffed6f",
    ),
  },
  {
    id: "Dark2",
    label: "Dark2",
    sequential: false,
    colors: hex("1b9e77 d95f02 7570b3 e7298a 66a61e e6ab02 a6761d 666666"),
  },
  {
    id: "Paired",
    label: "Paired",
    sequential: false,
    colors: hex(
      "a6cee3 1f78b4 b2df8a 33a02c fb9a99 e31a1c fdbf6f ff7f00 cab2d6 6a3d9a ffff99 b15928",
    ),
  },
  {
    id: "Pastel1",
    label: "Pastel1",
    sequential: false,
    colors: hex("fbb4ae b3cde3 ccebc5 decbe4 fed9a6 ffffcc e5d8bd fddaec f2f2f2"),
  },
  {
    id: "Pastel2",
    label: "Pastel2",
    sequential: false,
    colors: hex("b3e2cd fdcdac cbd5e8 f4cae4 e6f5c9 fff2ae f1e2cc cccccc"),
  },
  {
    id: "Accent",
    label: "Accent",
    sequential: false,
    colors: hex("7fc97f beaed4 fdc086 ffff99 386cb0 f0027f bf5b17 666666"),
  },
  {
    id: "viridis",
    label: "viridis",
    sequential: true,
    colors: hex("440154 472d7b 3b528b 2c728e 21918c 28ae80 5ec962 addc30 fde725"),
  },
  {
    id: "plasma",
    label: "plasma",
    sequential: true,
    colors: hex("0d0887 46039f 7201a8 9c179e bd3786 d8576b ed7953 fb9f3a fdca26 f0f921"),
  },
  {
    id: "inferno",
    label: "inferno",
    sequential: true,
    colors: hex("000004 1b0c41 4a0c6b 781c6d a52c60 cf4446 ed6925 fb9b06 f7d13d fcffa4"),
  },
  {
    id: "magma",
    label: "magma",
    sequential: true,
    colors: hex("000004 180f3d 440f76 721f81 9e2f7f cd4071 f1605d fd9668 feca8d fcfdbf"),
  },
  {
    id: "cividis",
    label: "cividis",
    sequential: true,
    colors: hex("00224e 123570 3b496c 575d6d 707173 8a8678 a59c74 c3b369 e1cc55 fee838"),
  },
]

function rgbOf(color: string): [number, number, number] {
  const value = Number.parseInt(color.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/** The color at `t` (0 to 1) along a sequential map, between its stops. */
function sample(stops: string[], t: number): string {
  const at = Math.min(1, Math.max(0, t)) * (stops.length - 1)
  const low = Math.floor(at)
  const high = Math.min(stops.length - 1, low + 1)
  const a = rgbOf(stops[low] ?? "#000000")
  const b = rgbOf(stops[high] ?? "#000000")
  const mix = (i: number) => Math.round((a[i] ?? 0) + ((b[i] ?? 0) - (a[i] ?? 0)) * (at - low))
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`
}

/**
 * The color of series `index` of `count` with palette `id` (an unknown id
 * gives the default colors).
 */
export function paletteColor(id: string, index: number, count: number): string {
  const palette = PALETTES.find((p) => p.id === id) ?? PALETTES[0]
  const colors = palette?.colors ?? []
  if (palette?.sequential) return sample(colors, count <= 1 ? 0.5 : index / (count - 1))
  return colors[index % colors.length] ?? "currentColor"
}
