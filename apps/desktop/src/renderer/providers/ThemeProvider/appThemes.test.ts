import { describe, expect, test } from "vitest"
import {
  APP_THEME_TOKENS,
  APP_THEMES,
  contrastRatio,
  DEFAULT_APP_THEME_ID,
  normalizeAppThemeId,
  resolveAppThemeTokens,
} from "./appThemes"

describe("app theme registry", () => {
  test("offers the curated themes with Default first and unique ids", () => {
    expect(APP_THEMES.map(({ label }) => label)).toEqual([
      "Default",
      "Tokyo Night",
      "Catppuccin",
      "Nord",
      "Gruvbox",
      "Solarized",
      "Rosé Pine",
      "Everforest",
      "Dracula",
    ])
    expect(APP_THEMES[0]?.id).toBe(DEFAULT_APP_THEME_ID)
    expect(new Set(APP_THEMES.map(({ id }) => id)).size).toBe(APP_THEMES.length)
  })

  test("expands every curated mode into the complete app color-token contract", () => {
    for (const theme of APP_THEMES.slice(1)) {
      for (const mode of ["light", "dark"] as const) {
        const tokens = resolveAppThemeTokens(theme.id, mode)
        expect(tokens).not.toBeNull()
        expect(Object.keys(tokens ?? {}).sort()).toEqual([...APP_THEME_TOKENS].sort())
        expect(Object.values(tokens ?? {}).every((value) => value.length > 0)).toBe(true)
      }
    }
    expect(resolveAppThemeTokens(DEFAULT_APP_THEME_ID, "light")).toBeNull()
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
