import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { APP_THEME_TOKENS, DEFAULT_APP_THEME_ID } from "./appThemes"
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
  const { mode, resolvedMode, setMode, themeId, setThemeId, toggleTheme } = useTheme()
  return (
    <>
      <output data-testid="theme-state">
        {mode}:{resolvedMode}:{themeId}
      </output>
      <button type="button" onClick={() => setMode("system")}>
        System
      </button>
      <button type="button" onClick={() => setThemeId("tokyo-night")}>
        Tokyo Night
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

  test("applies every curated token and clears every override on Default", async () => {
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
    for (const token of APP_THEME_TOKENS) {
      expect(document.documentElement.style.getPropertyValue(`--${token}`)).not.toBe("")
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
})
