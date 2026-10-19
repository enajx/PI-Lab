import { APP_ICON_DEFAULT_SELECTION } from "../../../../../../shared/appIcon"

/**
 * The twelve uppercase Pi font choices offered by the app icon picker.
 *
 * The picker uses palette-specific PNGs made from the original font treatments.
 * Rendering a live glyph would depend on fonts installed on the user's machine.
 */

export interface PiIconFont {
  /** Stable id used in the generated PNG name and the saved choice. */
  id: string
  label: string
}

/** The default Pi font when no icon choice has been saved. */
export const DEFAULT_PI_ICON_FONT_ID = APP_ICON_DEFAULT_SELECTION.piFont

export const PI_ICON_FONTS: readonly PiIconFont[] = [
  {
    id: "baskerville-regular",
    label: "Baskerville — Regular",
  },
  {
    id: "didot-bold",
    label: "Didot — Bold",
  },
  {
    id: "times-new-roman-regular",
    label: "Times New Roman — Regular",
  },
  {
    id: "georgia-regular",
    label: "Georgia — Regular",
  },
  {
    id: "palatino-regular",
    label: "Palatino — Regular",
  },
  {
    id: "stix-two-text-regular",
    label: "STIX Two Text — Regular",
  },
  {
    id: "avenir-next-medium",
    label: "Avenir Next — Medium",
  },
  {
    id: "futura-medium",
    label: "Futura — Medium",
  },
  {
    id: DEFAULT_PI_ICON_FONT_ID,
    label: "Helvetica Neue — Medium",
  },
  {
    id: "gill-sans-regular",
    label: "Gill Sans — Regular",
  },
  {
    id: "rockwell-regular",
    label: "Rockwell — Regular",
  },
  {
    id: "copperplate-regular",
    label: "Copperplate — Regular",
  },
]

export const PI_ICON_FONT_IDS: ReadonlySet<string> = new Set(PI_ICON_FONTS.map((font) => font.id))
