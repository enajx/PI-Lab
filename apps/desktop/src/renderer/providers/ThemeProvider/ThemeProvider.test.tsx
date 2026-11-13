import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import {
  ACCENT_THEME_TOKENS,
  APP_THEME_TOKENS,
  BASE_THEME_TOKENS,
  DEFAULT_APP_THEME_ID,
} from "./appThemes"
import { ThemeProvider, useTheme } from "./ThemeProvider"

interface MediaController {
  setDark: (dark: boolean) => void
  listenerCount: () => number
}

function installMatchMedia(initialDark: boolean): MediaController {
  let matches = initialDark
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return matches
      },
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
      dispatchEvent: () => true,
    })),
  )
  return {
    listenerCount: () => listeners.size,
    setDark(dark) {
      matches = dark
      const event = { matches: dark } as MediaQueryListEvent
      for (const listener of listeners) listener(event)
    },
  }
}

function ThemeHarness() {
  const {
    mode,
    resolvedMode,
    setMode,
    themeId,
    setThemeId,
    themes,
    toggleTheme,
    unavailableTheme,
    accentId,
    setAccentId,
    previewThemeId,
    previewAccentId,
    previewMode,
  } = useTheme()
  return (
    <>
      <output data-testid="theme-state">
        {mode}:{resolvedMode}:{themeId}
      </output>
      <output data-testid="theme-count">{themes.length}</output>
      <output data-testid="theme-accent">{accentId}</output>
      <output data-testid="theme-unavailable">{unavailableTheme ?? ""}</output>
      <button type="button" onClick={() => setMode("system")}>
        System
      </button>
      <button type="button" onClick={() => setThemeId("tokyo-night")}>
        Tokyo Night
      </button>
      <button type="button" onClick={() => setAccentId("ember")}>
        Ember
      </button>
      <button type="button" onClick={() => previewMode("dark")}>
        Preview dark
      </button>
      <button type="button" onClick={() => previewMode(null)}>
        End mode preview
      </button>
      <button type="button" onClick={() => previewThemeId("nord")}>
        Preview Nord
      </button>
      <button type="button" onClick={() => previewAccentId("ember")}>
        Preview Ember
      </button>
      <button
        type="button"
        onClick={() => {
          previewThemeId(null)
          previewAccentId(null)
        }}
      >
        End preview
      </button>
      <button type="button" onClick={() => setAccentId("default")}>
        Theme default
      </button>
      <button type="button" onClick={() => setThemeId(DEFAULT_APP_THEME_ID)}>
        Default
      </button>
      <button type="button" onClick={toggleTheme}>
        Toggle
      </button>
    </>
  )
}

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.classList.remove("dark")
  document.documentElement.removeAttribute("style")
  vi.unstubAllGlobals()
})

describe("ThemeProvider", () => {
  test("follows the initial and live OS mode while system is selected", async () => {
    const media = installMatchMedia(true)
    const { unmount } = render(
      <ThemeProvider>
        <ThemeHarness />
      </ThemeProvider>,
    )
    fireEvent.click(screen.getByRole("button", { name: "System" }))

    await waitFor(() =>
      expect(screen.getByTestId("theme-state").textContent).toBe("system:dark:default"),
    )
    expect(document.documentElement.classList.contains("dark")).toBe(true)

    act(() => media.setDark(false))
    await waitFor(() =>
      expect(screen.getByTestId("theme-state").textContent).toBe("system:light:default"),
    )
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(media.listenerCount()).toBe(1)
    unmount()
    expect(media.listenerCount()).toBe(0)
  })

  test("applies every base token and clears every override on Default", async () => {
    installMatchMedia(false)
    render(
      <ThemeProvider>
        <ThemeHarness />
      </ThemeProvider>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Tokyo Night" }))

    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("#e1e2e7"),
    )
    for (const token of BASE_THEME_TOKENS) {
      expect(document.documentElement.style.getPropertyValue(`--${token}`)).not.toBe("")
    }
    for (const token of ACCENT_THEME_TOKENS) {
      expect(document.documentElement.style.getPropertyValue(`--${token}`)).toBe("")
    }

    fireEvent.click(screen.getByRole("button", { name: "Default" }))
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--background")).toBe(""),
    )
    for (const token of APP_THEME_TOKENS) {
      expect(document.documentElement.style.getPropertyValue(`--${token}`)).toBe("")
    }
  })

  test("normalizes stale storage, persists both choices, and toggles out of system", async () => {
    const media = installMatchMedia(true)
    window.localStorage.setItem("pi-lab.theme", "system")
    window.localStorage.setItem("pi-lab.appTheme", "removed-theme")
    render(
      <ThemeProvider>
        <ThemeHarness />
      </ThemeProvider>,
    )

    await waitFor(() =>
      expect(screen.getByTestId("theme-state").textContent).toBe("system:dark:default"),
    )
    expect(window.localStorage.getItem("pi-lab.appTheme")).toBe("default")

    fireEvent.click(screen.getByRole("button", { name: "Tokyo Night" }))
    expect(window.localStorage.getItem("pi-lab.appTheme")).toBe("tokyo-night")
    fireEvent.click(screen.getByRole("button", { name: "Toggle" }))
    await waitFor(() =>
      expect(screen.getByTestId("theme-state").textContent).toBe("light:light:tokyo-night"),
    )
    expect(window.localStorage.getItem("pi-lab.theme")).toBe("light")

    act(() => media.setDark(false))
    expect(screen.getByTestId("theme-state").textContent).toBe("light:light:tokyo-night")
  })

  test("a chosen accent overrides the theme and Theme default clears it, and both are saved", async () => {
    installMatchMedia(false)
    render(
      <ThemeProvider>
        <ThemeHarness />
      </ThemeProvider>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Tokyo Night" }))
    fireEvent.click(screen.getByRole("button", { name: "Ember" }))
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--panel-border")).toBe("#c4540f"),
    )
    for (const token of ACCENT_THEME_TOKENS) {
      expect(document.documentElement.style.getPropertyValue(`--${token}`)).not.toBe("")
    }
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe("#c4540f")
    expect(window.localStorage.getItem("pi-lab.appAccent")).toBe("ember")

    fireEvent.click(screen.getByRole("button", { name: "Theme default" }))
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--panel-border")).toBe(""),
    )
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe("#2e7de9")
    expect(window.localStorage.getItem("pi-lab.appAccent")).toBe("default")
  })

  test("restores a saved accent and resets an unknown one to Theme default", () => {
    installMatchMedia(false)
    window.localStorage.setItem("pi-lab.appAccent", "#ff00aa")
    const { unmount } = render(
      <ThemeProvider>
        <ThemeHarness />
      </ThemeProvider>,
    )
    expect(screen.getByTestId("theme-accent").textContent).toBe("#ff00aa")
    unmount()
    window.localStorage.setItem("pi-lab.appAccent", "removed")
    render(
      <ThemeProvider>
        <ThemeHarness />
      </ThemeProvider>,
    )
    expect(screen.getByTestId("theme-accent").textContent).toBe("default")
  })

  test("Beta lists only kept themes and shows Default for a saved Alpha-only theme", async () => {
    installMatchMedia(false)
    window.localStorage.setItem("pi-lab.appTheme", "cyberpunk")
    const previous = window.piLab
    window.piLab = {
      ...previous,
      appIcon: { ...previous?.appIcon, getChannel: async () => "beta" },
    } as NonNullable<typeof window.piLab>
    render(
      <ThemeProvider>
        <ThemeHarness />
      </ThemeProvider>,
    )

    await waitFor(() => expect(screen.getByTestId("theme-count").textContent).toBe("9"))
    expect(screen.getByTestId("theme-state").textContent).toBe("light:light:default")
    expect(screen.getByTestId("theme-unavailable").textContent).toBe("Cyberpunk")
    for (const token of APP_THEME_TOKENS) {
      expect(document.documentElement.style.getPropertyValue(`--${token}`)).toBe("")
    }
    // The saved choice is kept, so the notice stays until the user picks a theme.
    expect(window.localStorage.getItem("pi-lab.appTheme")).toBe("cyberpunk")

    fireEvent.click(screen.getByRole("button", { name: "Tokyo Night" }))
    expect(screen.getByTestId("theme-unavailable").textContent).toBe("")
    expect(window.localStorage.getItem("pi-lab.appTheme")).toBe("tokyo-night")
    window.piLab = previous
  })

  test("a preview applies a theme and accent without saving, and ending it restores the saved ones", async () => {
    installMatchMedia(false)
    render(
      <ThemeProvider>
        <ThemeHarness />
      </ThemeProvider>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Tokyo Night" }))
    fireEvent.click(screen.getByRole("button", { name: "Preview Nord" }))
    fireEvent.click(screen.getByRole("button", { name: "Preview Ember" }))
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("#eceff4"),
    )
    expect(document.documentElement.style.getPropertyValue("--panel-border")).toBe("#c4540f")
    expect(screen.getByTestId("theme-state").textContent).toBe("light:light:nord")
    expect(window.localStorage.getItem("pi-lab.appTheme")).toBe("tokyo-night")
    expect(window.localStorage.getItem("pi-lab.appAccent")).toBe("default")

    fireEvent.click(screen.getByRole("button", { name: "End preview" }))
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("#e1e2e7"),
    )
    expect(document.documentElement.style.getPropertyValue("--panel-border")).toBe("")

    // Picking a theme during a preview saves it and ends the theme preview.
    fireEvent.click(screen.getByRole("button", { name: "Preview Nord" }))
    fireEvent.click(screen.getByRole("button", { name: "Tokyo Night" }))
    await waitFor(() =>
      expect(screen.getByTestId("theme-state").textContent).toBe("light:light:tokyo-night"),
    )
  })

  test("a mode preview switches light and dark without saving", async () => {
    installMatchMedia(false)
    render(
      <ThemeProvider>
        <ThemeHarness />
      </ThemeProvider>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Preview dark" }))
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true))
    expect(window.localStorage.getItem("pi-lab.theme")).toBe("light")
    fireEvent.click(screen.getByRole("button", { name: "End mode preview" }))
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(false))
  })
})
