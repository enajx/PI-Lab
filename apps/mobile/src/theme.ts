import { Platform } from "react-native"

/** Dark colours close to Linear's mobile app. */
export const colors = {
  background: "#0E0E10",
  card: "#18181B",
  cardPressed: "#222226",
  border: "#2A2A2F",
  text: "#EDEDEF",
  muted: "#8B8D98",
  faint: "#5C5E68",
  accent: "#5E6AD2",
  waiting: "#E2A03F",
  working: "#4CB782",
  finished: "#4EA7FC",
  danger: "#EB5757",
  footer: "#1C1C20",
}

export const mono = Platform.select({ ios: "Menlo", default: "monospace" })

/** Space under scrolled lists so the floating footer does not cover the last row. */
export const FOOTER_SPACE = 110
