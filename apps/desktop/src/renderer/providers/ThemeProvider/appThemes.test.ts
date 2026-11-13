import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"
import {
  ACCENT_THEME_TOKENS,
  APP_THEME_TOKENS,
  APP_THEMES,
  accentEditorColors,
  appThemesForChannel,
  availableAppThemeId,
  BASE_THEME_TOKENS,
  contrastRatio,
  DEFAULT_APP_THEME_ID,
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

const accentThemes = APP_THEMES.filter((theme) => theme.accent !== null)
const plainThemes = APP_THEMES.slice(1).filter((theme) => theme.accent === null)

describe("app theme registry", () => {
  test("Alpha offers the kept, trial and accent themes with Default first and unique ids", () => {
    const labels = appThemesForChannel("alpha").map(({ label }) => label)
    expect(labels.slice(0, 25)).toEqual([...KEPT_LABELS, ...TRIAL_LABELS])
    expect(labels).toHaveLength(35)
    expect(accentThemes).toHaveLength(10)
    expect(APP_THEMES[0]?.id).toBe(DEFAULT_APP_THEME_ID)
    expect(new Set(APP_THEMES.map(({ id }) => id)).size).toBe(APP_THEMES.length)
  })

  test("Beta and Stable offer only the kept themes", () => {
    for (const channel of ["beta", "stable"] as const) {
      expect(appThemesForChannel(channel).map(({ label }) => label)).toEqual(KEPT_LABELS)
    }
  })

  test("a saved theme that the channel does not offer falls back to Default", () => {
    const accentId = accentThemes[0]?.id ?? ""
    expect(availableAppThemeId(accentId, "beta")).toBe(DEFAULT_APP_THEME_ID)
    expect(availableAppThemeId("cyberpunk", "stable")).toBe(DEFAULT_APP_THEME_ID)
    expect(availableAppThemeId("nord", "beta")).toBe("nord")
    expect(availableAppThemeId(accentId, "alpha")).toBe(accentId)
    expect(availableAppThemeId("removed-theme", "alpha")).toBe(DEFAULT_APP_THEME_ID)
  })

  test("expands every theme mode into the base app color-token contract", () => {
    for (const theme of APP_THEMES.slice(1)) {
      for (const mode of ["light", "dark"] as const) {
        const tokens = resolveAppThemeTokens(theme.id, mode)
        expect(tokens).not.toBeNull()
        for (const token of BASE_THEME_TOKENS) expect(tokens?.[token]).toMatch(/^#[0-9a-f]{6}$/u)
      }
    }
    expect(resolveAppThemeTokens(DEFAULT_APP_THEME_ID, "light")).toBeNull()
    expect(APP_THEME_TOKENS).toEqual([...BASE_THEME_TOKENS, ...ACCENT_THEME_TOKENS])
  })

  test("normalizes an obsolete saved id to Default", () => {
    expect(normalizeAppThemeId("removed-theme")).toBe(DEFAULT_APP_THEME_ID)
    expect(normalizeAppThemeId(null)).toBe(DEFAULT_APP_THEME_ID)
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
        const tokens = resolveAppThemeTokens(theme.id, mode)
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

describe("accent theme tokens", () => {
  test("themes without an accent leave the accent tokens unset", () => {
    for (const theme of plainThemes) {
      for (const mode of ["light", "dark"] as const) {
        const tokens = resolveAppThemeTokens(theme.id, mode)
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

  test("accent themes color the panel borders, titles, selection and buttons readably", () => {
    for (const theme of accentThemes) {
      for (const mode of ["light", "dark"] as const) {
        const tokens = resolveAppThemeTokens(theme.id, mode)
        const accent = theme.accent?.[mode].accent
        const label = `${theme.label} ${mode}`
        expect(tokens?.["panel-border"], label).toBe(accent)
        expect(tokens?.primary, label).toBe(accent)
        expect(tokens?.ring, label).toBe(accent)
        for (const token of ["panel-title", "heading"] as const) {
          for (const surface of ["background", "card", "sidebar"] as const) {
            expect(
              contrastRatio(tokens?.[surface] ?? "", tokens?.[token] ?? ""),
              `${label}: ${token} on ${surface}`,
            ).toBeGreaterThanOrEqual(4.5)
          }
        }
        for (const surface of ["selected", "background"] as const) {
          expect(
            contrastRatio(tokens?.[surface] ?? "", tokens?.["selected-foreground"] ?? ""),
            `${label}: selected-foreground on ${surface}`,
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  test("only accent themes drive the code editor colors, with readable syntax", () => {
    expect(accentEditorColors("nord", "dark")).toBeNull()
    expect(accentEditorColors(DEFAULT_APP_THEME_ID, "light")).toBeNull()
    for (const theme of accentThemes) {
      for (const mode of ["light", "dark"] as const) {
        const colors = accentEditorColors(theme.id, mode)
        expect(colors?.keyword).toBe(resolveAppThemeTokens(theme.id, mode)?.heading)
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
            `${theme.label} ${mode}: ${role}`,
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })
})
