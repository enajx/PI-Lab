import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"
import {
  ACCENT_THEME_TOKENS,
  APP_ACCENTS,
  APP_THEME_TOKENS,
  APP_THEMES,
  accentEditorColors,
  appThemesForChannel,
  availableAppThemeId,
  BASE_THEME_TOKENS,
  contrastRatio,
  DEFAULT_APP_THEME_ID,
  normalizeAccentId,
  normalizeAppThemeId,
  resolveAppThemeTokens,
} from "./appThemes"

const KEPT_LABELS = [
  "Default",
  "Tokyo Night",
  "Catppuccin",
  "Nord",
  "Gruvbox",
  "Solarized",
  "Rosé Pine",
  "Everforest",
  "Dracula",
]

const TRIAL_LABELS = [
  "One Dark / One Light",
  "GitHub",
  "Ayu",
  "Monokai",
  "Material",
  "Zenburn",
  "Warm Paper",
  "Night Owl",
  "iA Writer Grey",
  "Graphite",
  "Slate",
  "Warm Grey",
  "Scandinavian Grey",
  "Pale Slate",
  "ASCII Terminal",
  "Cyberpunk",
]

const ACCENT_LABELS = [
  "Neon Pink",
  "Ember",
  "Lagoon",
  "Acid Lime",
  "Ultraviolet",
  "Amber",
  "Crimson",
  "Glacier",
  "Mint",
  "Cobalt",
]
const CUSTOM = "#3aa7a0"
const ACCENT_IDS = [...APP_ACCENTS.map(({ id }) => id), CUSTOM]
const MODES = ["light", "dark"] as const

describe("app theme registry", () => {
  test("Alpha offers the kept and trial themes with Default first and unique ids", () => {
    expect(appThemesForChannel("alpha").map(({ label }) => label)).toEqual([
      ...KEPT_LABELS,
      ...TRIAL_LABELS,
    ])
    expect(APP_ACCENTS.map(({ label }) => label)).toEqual(ACCENT_LABELS)
    expect(APP_THEMES[0]?.id).toBe(DEFAULT_APP_THEME_ID)
    expect(new Set(APP_THEMES.map(({ id }) => id)).size).toBe(APP_THEMES.length)
  })

  test("Beta and Stable offer only the kept themes", () => {
    for (const channel of ["beta", "stable"] as const) {
      expect(appThemesForChannel(channel).map(({ label }) => label)).toEqual(KEPT_LABELS)
    }
  })

  test("a saved theme that the channel does not offer falls back to Default", () => {
    expect(availableAppThemeId("cyberpunk", "beta")).toBe(DEFAULT_APP_THEME_ID)
    expect(availableAppThemeId("cyberpunk", "stable")).toBe(DEFAULT_APP_THEME_ID)
    expect(availableAppThemeId("nord", "beta")).toBe("nord")
    expect(availableAppThemeId("cyberpunk", "alpha")).toBe("cyberpunk")
    expect(availableAppThemeId("removed-theme", "alpha")).toBe(DEFAULT_APP_THEME_ID)
  })

  test("expands every theme mode into the base app color-token contract", () => {
    for (const theme of APP_THEMES.slice(1)) {
      for (const mode of ["light", "dark"] as const) {
        const tokens = resolveAppThemeTokens(theme.id, mode, "default")
        expect(tokens).not.toBeNull()
        for (const token of BASE_THEME_TOKENS) expect(tokens?.[token]).toMatch(/^#[0-9a-f]{6}$/u)
      }
    }
    expect(resolveAppThemeTokens(DEFAULT_APP_THEME_ID, "light", "default")).toBeNull()
    expect(APP_THEME_TOKENS).toEqual([...BASE_THEME_TOKENS, ...ACCENT_THEME_TOKENS])
  })

  test("normalizes an obsolete saved id, including an earlier accent theme, to Default", () => {
    expect(normalizeAppThemeId("removed-theme")).toBe(DEFAULT_APP_THEME_ID)
    expect(normalizeAppThemeId("neon-pink")).toBe(DEFAULT_APP_THEME_ID)
    expect(normalizeAppThemeId(null)).toBe(DEFAULT_APP_THEME_ID)
  })

  test("keeps a known accent or a custom hex color, otherwise Theme default", () => {
    expect(normalizeAccentId("ember")).toBe("ember")
    expect(normalizeAccentId("#FF00AA")).toBe("#ff00aa")
    expect(normalizeAccentId("#ff00a")).toBe("default")
    expect(normalizeAccentId("removed-accent")).toBe("default")
    expect(normalizeAccentId(null)).toBe("default")
  })

  test("keeps semantic text pairs at normal-text contrast in every curated palette", () => {
    const pairs = [
      ["background", "foreground"],
      ["card", "card-foreground"],
      ["popover", "popover-foreground"],
      ["primary", "primary-foreground"],
      ["secondary", "secondary-foreground"],
      ["muted", "muted-foreground"],
      ["accent", "accent-foreground"],
      ["destructive", "destructive-foreground"],
      ["sidebar", "sidebar-foreground"],
    ] as const

    for (const theme of APP_THEMES.slice(1)) {
      for (const mode of ["light", "dark"] as const) {
        const tokens = resolveAppThemeTokens(theme.id, mode, "default")
        expect(tokens).not.toBeNull()
        for (const [background, foreground] of pairs) {
          expect(
            contrastRatio(tokens?.[background] ?? "", tokens?.[foreground] ?? ""),
            `${theme.label} ${mode}: ${foreground} on ${background}`,
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })
})

describe("accent tokens", () => {
  test("Theme default leaves the accent tokens unset in every theme", () => {
    for (const theme of APP_THEMES) {
      for (const mode of MODES) {
        const tokens = resolveAppThemeTokens(theme.id, mode, "default")
        for (const token of ACCENT_THEME_TOKENS) expect(tokens?.[token]).toBeUndefined()
      }
    }
  })

  test("unset accent tokens fall back to the colors those places use today", () => {
    const css = readFileSync(
      resolve(__dirname, "../../../../../../packages/ui/src/styles/globals.css"),
      "utf8",
    )
    for (const line of [
      "--color-panel-border: var(--panel-border, var(--border));",
      "--color-panel-title: var(--panel-title, var(--muted-foreground));",
      "--color-heading: var(--heading, var(--foreground));",
      "--color-selected: var(--selected, var(--accent));",
      "--color-selected-foreground: var(--selected-foreground, var(--foreground));",
      "--color-selected-accent-foreground: var(--selected-foreground, var(--accent-foreground));",
    ]) {
      expect(css).toContain(line)
    }
  })

  test("a chosen accent colors borders, titles, selection, buttons and ring readably in every theme", () => {
    for (const theme of APP_THEMES) {
      for (const accentId of ACCENT_IDS) {
        for (const mode of MODES) {
          const label = `${theme.label} + ${accentId} ${mode}`
          const tokens = resolveAppThemeTokens(theme.id, mode, accentId)
          const surfaces = theme[mode]
          const shade = tokens?.["panel-border"] ?? ""
          expect(shade, label).toMatch(/^#[0-9a-f]{6}$/u)
          expect(tokens?.primary, label).toBe(shade)
          expect(tokens?.ring, label).toBe(shade)
          expect(
            contrastRatio(shade, tokens?.["primary-foreground"] ?? ""),
            `${label}: button text`,
          ).toBeGreaterThanOrEqual(4.5)
          for (const token of ["panel-title", "heading"] as const) {
            for (const surface of [surfaces.background, surfaces.surface, surfaces.sidebar]) {
              expect(
                contrastRatio(surface, tokens?.[token] ?? ""),
                `${label}: ${token} on ${surface}`,
              ).toBeGreaterThanOrEqual(4.5)
            }
          }
          for (const surface of [tokens?.selected ?? "", surfaces.background]) {
            expect(
              contrastRatio(surface, tokens?.["selected-foreground"] ?? ""),
              `${label}: selected-foreground on ${surface}`,
            ).toBeGreaterThanOrEqual(4.5)
          }
        }
      }
    }
  })

  test("a preset accent uses its tuned shade for each mode", () => {
    const ember = APP_ACCENTS.find(({ id }) => id === "ember")
    expect(resolveAppThemeTokens("nord", "dark", "ember")?.["panel-border"]).toBe(
      ember?.dark.accent,
    )
    expect(resolveAppThemeTokens("nord", "light", "ember")?.["panel-border"]).toBe(
      ember?.light.accent,
    )
  })

  test("an accent on Default sets only the accent colors and keeps globals.css for the rest", () => {
    const tokens = resolveAppThemeTokens(DEFAULT_APP_THEME_ID, "dark", "neon-pink")
    expect(tokens?.["panel-border"]).toBeDefined()
    expect(tokens?.background).toBeUndefined()
    expect(tokens?.border).toBeUndefined()
  })

  test("only a chosen accent drives the code editor colors, with readable syntax", () => {
    expect(accentEditorColors("nord", "dark", "default")).toBeNull()
    expect(accentEditorColors(DEFAULT_APP_THEME_ID, "light", "default")).toBeNull()
    for (const theme of APP_THEMES) {
      for (const accentId of ACCENT_IDS) {
        for (const mode of MODES) {
          const colors = accentEditorColors(theme.id, mode, accentId)
          expect(colors?.keyword).toBe(resolveAppThemeTokens(theme.id, mode, accentId)?.heading)
          for (const role of [
            "foreground",
            "keyword",
            "string",
            "number",
            "function",
            "type",
          ] as const) {
            expect(
              contrastRatio(colors?.background ?? "", colors?.[role] ?? ""),
              `${theme.label} + ${accentId} ${mode}: ${role}`,
            ).toBeGreaterThanOrEqual(4.5)
          }
        }
      }
    }
  })
})
