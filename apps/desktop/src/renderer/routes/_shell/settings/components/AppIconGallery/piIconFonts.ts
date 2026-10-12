/**
 * The twelve uppercase-Pi tile treatments offered by the Settings comparison
 * gallery.
 *
 * Each preview is a committed 256px PNG downscaled from the corresponding
 * 1024px master in `icons-temp/` by
 * `apps/desktop/scripts/generate-icon-explorations.ts`. Shipping pixels rather
 * than font names is deliberate: rendering `Π` as live text would silently fall
 * back to another face on a machine missing the font, which is exactly what the
 * generator's isolated fontconfig setup exists to prevent.
 *
 * This gallery is a *comparison surface only*. The shipped application icon
 * stays the outlined Avenir Next Medium path pinned in `icons/icon.manifest.json`
 * until a pick is explicitly promoted, so nothing here touches app identity.
 */

export interface PiIconFont {
  /** Stable id, also the preview file's basename and the persisted value. */
  id: string
  label: string
  previewUrl: string
}

/** The face whose outline the shipped `icons/icon.svg` actually contains. */
export const SHIPPED_PI_ICON_FONT_ID = "avenir-next-medium"

export const PI_ICON_FONTS: readonly PiIconFont[] = [
  {
    id: "baskerville-regular",
    label: "Baskerville — Regular",
    previewUrl: new URL("./icons/baskerville-regular.png", import.meta.url).href,
  },
  {
    id: "didot-bold",
    label: "Didot — Bold",
    previewUrl: new URL("./icons/didot-bold.png", import.meta.url).href,
  },
  {
    id: "times-new-roman-regular",
    label: "Times New Roman — Regular",
    previewUrl: new URL("./icons/times-new-roman-regular.png", import.meta.url).href,
  },
  {
    id: "georgia-regular",
    label: "Georgia — Regular",
    previewUrl: new URL("./icons/georgia-regular.png", import.meta.url).href,
  },
  {
    id: "palatino-regular",
    label: "Palatino — Regular",
    previewUrl: new URL("./icons/palatino-regular.png", import.meta.url).href,
  },
  {
    id: "stix-two-text-regular",
    label: "STIX Two Text — Regular",
    previewUrl: new URL("./icons/stix-two-text-regular.png", import.meta.url).href,
  },
  {
    id: SHIPPED_PI_ICON_FONT_ID,
    label: "Avenir Next — Medium",
    previewUrl: new URL("./icons/avenir-next-medium.png", import.meta.url).href,
  },
  {
    id: "futura-medium",
    label: "Futura — Medium",
    previewUrl: new URL("./icons/futura-medium.png", import.meta.url).href,
  },
  {
    id: "helvetica-neue-medium",
    label: "Helvetica Neue — Medium",
    previewUrl: new URL("./icons/helvetica-neue-medium.png", import.meta.url).href,
  },
  {
    id: "gill-sans-regular",
    label: "Gill Sans — Regular",
    previewUrl: new URL("./icons/gill-sans-regular.png", import.meta.url).href,
  },
  {
    id: "rockwell-regular",
    label: "Rockwell — Regular",
    previewUrl: new URL("./icons/rockwell-regular.png", import.meta.url).href,
  },
  {
    id: "copperplate-regular",
    label: "Copperplate — Regular",
    previewUrl: new URL("./icons/copperplate-regular.png", import.meta.url).href,
  },
]

export const PI_ICON_FONT_IDS: ReadonlySet<string> = new Set(PI_ICON_FONTS.map((font) => font.id))
