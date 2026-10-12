import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, test } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../../../test/fakeTrpcClient"
import { AppIconGallery } from "./AppIconGallery"
import { PI_ICON_FONTS, SHIPPED_PI_ICON_FONT_ID } from "./piIconFonts"

/**
 * The Settings → Appearance Pi comparison gallery. These cover what the feature
 * actually promises: every declared treatment is visible and pickable, the pick
 * persists, and — critically — choosing one does not touch the shipped icon.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const PREFERENCE_KEY = "pi-lab.appearance.iconPiFont"

function renderGallery() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AppProviders client={createFakeTrpcClient({})} queryClient={queryClient}>
      <AppIconGallery />
    </AppProviders>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
})

describe("AppIconGallery", () => {
  test("every declared treatment ships a committed preview asset", () => {
    expect(PI_ICON_FONTS).toHaveLength(12)
    for (const font of PI_ICON_FONTS) {
      const preview = join(HERE, "icons", `${font.id}.png`)
      expect(existsSync(preview), `missing preview asset for ${font.id}`).toBe(true)
    }
  })

  test("renders all twelve treatments and preselects the shipped one", () => {
    renderGallery()

    const grid = screen.getByTestId("settings-app-icon-fonts")
    expect(grid.querySelectorAll("button")).toHaveLength(12)

    const shipped = screen.getByTestId(`settings-app-icon-font-${SHIPPED_PI_ICON_FONT_ID}`)
    expect(shipped.getAttribute("aria-pressed")).toBe("true")
  })

  test("picking a treatment persists it and moves the selection", () => {
    renderGallery()

    fireEvent.click(screen.getByTestId("settings-app-icon-font-didot-bold"))

    expect(window.localStorage.getItem(PREFERENCE_KEY)).toBe("didot-bold")
    expect(
      screen.getByTestId("settings-app-icon-font-didot-bold").getAttribute("aria-pressed"),
    ).toBe("true")
    expect(
      screen
        .getByTestId(`settings-app-icon-font-${SHIPPED_PI_ICON_FONT_ID}`)
        .getAttribute("aria-pressed"),
    ).toBe("false")
  })

  test("an unknown stored value falls back to the shipped treatment", () => {
    window.localStorage.setItem(PREFERENCE_KEY, "a-font-that-no-longer-ships")
    renderGallery()

    const pressed = screen
      .getByTestId("settings-app-icon-fonts")
      .querySelectorAll('button[aria-pressed="true"]')
    expect(pressed).toHaveLength(1)
    expect(pressed[0]?.getAttribute("data-testid")).toBe(
      `settings-app-icon-font-${SHIPPED_PI_ICON_FONT_ID}`,
    )
  })

  test("picking a treatment leaves the shipped icon master and its digests untouched", async () => {
    const repoRoot = resolve(HERE, "..", "..", "..", "..", "..", "..", "..", "..", "..")
    const manifestPath = join(repoRoot, "icons", "icon.manifest.json")
    const svgPath = join(repoRoot, "icons", "icon.svg")
    const { readFileSync } = await import("node:fs")
    const manifestBefore = readFileSync(manifestPath, "utf8")
    const svgBefore = readFileSync(svgPath, "utf8")

    renderGallery()
    fireEvent.click(screen.getByTestId("settings-app-icon-font-copperplate-regular"))

    expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore)
    expect(readFileSync(svgPath, "utf8")).toBe(svgBefore)
  })
})
