import { QueryClient } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import {
  APP_ICON_DEFAULT_SELECTION,
  APP_ICON_JOYPLOT_STYLES,
  APP_ICON_PALETTES,
  type AppIconBridge,
  type AppIconSelection,
} from "../../../../../../shared/appIcon"
import { setInterfaceLanguage } from "../../../../../i18n/language"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../../../test/fakeTrpcClient"
import { AppIconGallery } from "./AppIconGallery"
import { PI_ICON_FONTS } from "./piIconFonts"

let savedSelection: AppIconSelection
let activeChannel: "alpha" | "beta" | "stable" = "stable"
const setIcon = vi.fn(async (selection: AppIconSelection): Promise<AppIconSelection> => {
  savedSelection = selection
  return selection
})

function renderGallery() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AppProviders client={createFakeTrpcClient({})} queryClient={queryClient}>
      <AppIconGallery />
    </AppProviders>,
  )
}

async function expectPreview(name: string): Promise<void> {
  await waitFor(() =>
    expect(screen.getByTestId("settings-app-icon-preview").getAttribute("src")).toContain(name),
  )
}

beforeEach(() => {
  activeChannel = "stable"
  savedSelection = { ...APP_ICON_DEFAULT_SELECTION }
  setIcon.mockClear()
  window.piLab = {
    platform: "darwin",
    shutdown: {} as NonNullable<typeof window.piLab>["shutdown"],
    appIcon: {
      getChannel: vi.fn(async () => activeChannel),
      get: vi.fn(async () => savedSelection),
      set: setIcon,
      preview: vi.fn(async (selection: AppIconSelection) => {
        const family = selection.family
        const variant = family === "joyplot" ? selection.joyplotStyle : selection.piFont
        const palette = family === "joyplot" ? selection.joyplotPalette : selection.piPalette
        const reversed = family === "joyplot" ? selection.joyplotReverse : selection.piReverse
        const limited =
          family === "joyplot" ? selection.joyplotLimitVisibleRange : selection.piLimitVisibleRange
        const expanded = family === "joyplot" && selection.joyplotExpanded
        return `icons/${family}-${variant}-${activeChannel === "alpha" ? activeChannel : palette}${reversed ? "-reversed" : ""}${limited ? "-limited" : ""}${expanded ? "-expanded" : ""}.png`
      }),
    },
  } as NonNullable<typeof window.piLab> & { appIcon: AppIconBridge }
})

describe("AppIconGallery", () => {
  test("fixes Alpha's palette while keeping both icon families selectable", async () => {
    activeChannel = "alpha"
    savedSelection = {
      ...APP_ICON_DEFAULT_SELECTION,
      joyplotPalette: "viridis",
      piPalette: "viridis",
    }
    renderGallery()
    await waitFor(() =>
      expect(screen.getByTestId("settings-app-icon-palette")).toHaveProperty("value", "viridis"),
    )
    const palette = screen.getByTestId("settings-app-icon-palette") as HTMLSelectElement
    expect(palette.disabled).toBe(true)
    expect(palette.options).toHaveLength(1)
    fireEvent.change(screen.getByTestId("settings-app-icon-family"), { target: { value: "pi" } })
    await expectPreview("pi-helvetica-neue-medium-alpha.png")
  })
  test("lets public Beta use the color selected for the shared Stable icon", async () => {
    activeChannel = "beta"
    savedSelection = { ...APP_ICON_DEFAULT_SELECTION, joyplotPalette: "plasma" }
    renderGallery()
    const palette = (await screen.findByTestId("settings-app-icon-palette")) as HTMLSelectElement
    await waitFor(() => expect(palette).toHaveProperty("value", "plasma"))
    expect(palette.disabled).toBe(false)
    expect(palette.options).toHaveLength(APP_ICON_PALETTES.length)
    fireEvent.change(palette, { target: { value: "viridis" } })
    await waitFor(() => expect(savedSelection.joyplotPalette).toBe("viridis"))
    await expectPreview("joyplot-25-viridis-expanded.png")
  })
  test("shows style 25 Magma Expanded as the initial icon", async () => {
    renderGallery()
    await waitFor(() =>
      expect(screen.getByTestId("settings-app-icon-style")).toHaveProperty("value", "25"),
    )
    expect(screen.getByTestId("settings-app-icon-palette")).toHaveProperty("value", "magma")
    expect((screen.getByTestId("settings-app-icon-expanded") as HTMLInputElement).checked).toBe(
      true,
    )
    await expectPreview("joyplot-25-magma-expanded.png")
    const styles = screen.getByTestId("settings-app-icon-style") as HTMLSelectElement
    expect([...styles.options].some((option) => option.value === "16")).toBe(false)
    expect((screen.getByTestId("settings-app-icon-palette") as HTMLSelectElement).disabled).toBe(
      false,
    )
    expect(screen.getByTestId("settings-app-icon-palette").querySelectorAll("option")).toHaveLength(
      APP_ICON_PALETTES.length,
    )
  })

  test("loads the saved icon and shows one large preview", async () => {
    savedSelection = {
      ...APP_ICON_DEFAULT_SELECTION,
      joyplotStyle: "33",
      joyplotPalette: "magma-iris",
    }
    renderGallery()

    await waitFor(() =>
      expect(screen.getByTestId("settings-app-icon-style")).toHaveProperty("value", "33"),
    )
    expect(screen.getByTestId("settings-app-icon-family")).toHaveProperty("value", "joyplot")
    expect(screen.getByTestId("settings-app-icon-palette")).toHaveProperty("value", "magma-iris")
    expect(screen.getAllByTestId("settings-app-icon-preview")).toHaveLength(1)
    await expectPreview("joyplot-33-magma-iris-expanded.png")
    expect(screen.queryByTestId("settings-app-icon-fonts")).toBeNull()
  })

  test("cycles only through the sparse Joyplot styles and wraps", async () => {
    renderGallery()
    await waitFor(() =>
      expect(screen.getByTestId("settings-app-icon-style")).toHaveProperty("value", "25"),
    )

    fireEvent.click(screen.getByTestId("settings-app-icon-next"))
    expect(screen.getByTestId("settings-app-icon-style")).toHaveProperty("value", "26")
    fireEvent.click(screen.getByTestId("settings-app-icon-previous"))
    expect(screen.getByTestId("settings-app-icon-style")).toHaveProperty("value", "25")

    fireEvent.change(screen.getByTestId("settings-app-icon-style"), { target: { value: "52" } })
    fireEvent.click(screen.getByTestId("settings-app-icon-next"))
    expect(screen.getByTestId("settings-app-icon-style")).toHaveProperty("value", "25")
    fireEvent.click(screen.getByTestId("settings-app-icon-previous"))
    expect(screen.getByTestId("settings-app-icon-style")).toHaveProperty("value", "52")
    expect(screen.getByTestId("settings-app-icon-style").querySelectorAll("option")).toHaveLength(
      APP_ICON_JOYPLOT_STYLES.length,
    )
    expect(
      [...(screen.getByTestId("settings-app-icon-style") as HTMLSelectElement).options]
        .filter((option) => Number(option.value) >= 43)
        .map((option) => option.value),
    ).toEqual(["43", "44", "45", "46", "47", "48", "49", "50", "51", "52"])
    await waitFor(() =>
      expect(setIcon).toHaveBeenLastCalledWith(expect.objectContaining({ joyplotStyle: "52" })),
    )
  })

  test("arrow keys preview and save each menu choice without Enter", async () => {
    renderGallery()
    await waitFor(() =>
      expect(screen.getByTestId("settings-app-icon-style")).toHaveProperty("value", "25"),
    )

    const style = screen.getByTestId("settings-app-icon-style")
    fireEvent.keyDown(style, { key: "ArrowDown" })
    expect(style).toHaveProperty("value", "26")
    await expectPreview("joyplot-26-magma-expanded.png")

    const palette = screen.getByTestId("settings-app-icon-palette")
    fireEvent.keyDown(palette, { key: "ArrowDown" })
    expect(palette).toHaveProperty("value", "magma-iris")
    await expectPreview("joyplot-26-magma-iris-expanded.png")

    fireEvent.change(screen.getByTestId("settings-app-icon-family"), { target: { value: "pi" } })
    const font = screen.getByTestId("settings-app-icon-font")
    fireEvent.keyDown(font, { key: "ArrowDown" })
    expect(font).toHaveProperty("value", "gill-sans-regular")
    await expectPreview("pi-gill-sans-regular-viridis.png")

    await waitFor(() =>
      expect(savedSelection).toEqual(
        expect.objectContaining({
          joyplotStyle: "26",
          joyplotPalette: "magma-iris",
          piFont: "gill-sans-regular",
        }),
      ),
    )
  })

  test("expands only Joyplot artwork and remembers the size across families", async () => {
    renderGallery()
    await waitFor(() => expect(screen.getByTestId("settings-app-icon-style")).toBeTruthy())
    const expanded = screen.getByTestId("settings-app-icon-expanded") as HTMLInputElement
    expect(expanded.checked).toBe(true)
    await expectPreview("joyplot-25-magma-expanded.png")

    fireEvent.click(expanded)
    expect(expanded.checked).toBe(false)
    await expectPreview("joyplot-25-magma.png")
    fireEvent.click(expanded)
    fireEvent.change(screen.getByTestId("settings-app-icon-style"), { target: { value: "26" } })
    await expectPreview("joyplot-26-magma-expanded.png")
    fireEvent.change(screen.getByTestId("settings-app-icon-family"), { target: { value: "pi" } })
    expect(screen.queryByTestId("settings-app-icon-expanded")).toBeNull()
    await expectPreview("pi-helvetica-neue-medium-viridis.png")
    fireEvent.change(screen.getByTestId("settings-app-icon-family"), {
      target: { value: "joyplot" },
    })
    expect((screen.getByTestId("settings-app-icon-expanded") as HTMLInputElement).checked).toBe(
      true,
    )
    await waitFor(() =>
      expect(setIcon).toHaveBeenLastCalledWith(expect.objectContaining({ joyplotExpanded: true })),
    )
  })

  test("remembers each family's variant and palette when switching", async () => {
    renderGallery()
    await waitFor(() =>
      expect(screen.getByTestId("settings-app-icon-style")).toHaveProperty("value", "25"),
    )

    fireEvent.change(screen.getByTestId("settings-app-icon-style"), { target: { value: "31" } })
    fireEvent.change(screen.getByTestId("settings-app-icon-palette"), {
      target: { value: "magma" },
    })
    fireEvent.change(screen.getByTestId("settings-app-icon-family"), { target: { value: "pi" } })
    expect(screen.getByTestId("settings-app-icon-font").querySelectorAll("option")).toHaveLength(12)
    fireEvent.change(screen.getByTestId("settings-app-icon-font"), {
      target: { value: "didot-bold" },
    })
    fireEvent.change(screen.getByTestId("settings-app-icon-palette"), {
      target: { value: "magma-iris" },
    })
    await expectPreview("pi-didot-bold-magma-iris.png")

    fireEvent.change(screen.getByTestId("settings-app-icon-family"), {
      target: { value: "joyplot" },
    })
    expect(screen.getByTestId("settings-app-icon-style")).toHaveProperty("value", "31")
    expect(screen.getByTestId("settings-app-icon-palette")).toHaveProperty("value", "magma")
    fireEvent.change(screen.getByTestId("settings-app-icon-family"), { target: { value: "pi" } })
    expect(screen.getByTestId("settings-app-icon-font")).toHaveProperty("value", "didot-bold")
    expect(screen.getByTestId("settings-app-icon-palette")).toHaveProperty("value", "magma-iris")
    await waitFor(() =>
      expect(savedSelection).toEqual({
        ...APP_ICON_DEFAULT_SELECTION,
        family: "pi",
        joyplotStyle: "31",
        joyplotPalette: "magma",
        joyplotExpanded: true,
        joyplotReverse: false,
        joyplotLimitVisibleRange: false,
        piFont: "didot-bold",
        piPalette: "magma-iris",
        piReverse: false,
        piLimitVisibleRange: false,
        favoriteIcons: [],
      }),
    )
  })

  test("remembers Reverse separately for Joyplot and Pi Lab", async () => {
    renderGallery()
    await waitFor(() => expect(screen.getByTestId("settings-app-icon-reverse")).toBeTruthy())
    const reverse = screen.getByTestId("settings-app-icon-reverse") as HTMLInputElement
    expect(reverse.checked).toBe(false)

    fireEvent.click(reverse)
    expect(reverse.checked).toBe(true)
    await expectPreview("joyplot-25-magma-reversed-expanded.png")

    fireEvent.change(screen.getByTestId("settings-app-icon-family"), { target: { value: "pi" } })
    expect(reverse.checked).toBe(false)
    fireEvent.click(reverse)
    expect(reverse.checked).toBe(true)
    await expectPreview("pi-helvetica-neue-medium-viridis-reversed.png")

    fireEvent.change(screen.getByTestId("settings-app-icon-family"), {
      target: { value: "joyplot" },
    })
    expect(reverse.checked).toBe(true)
    await waitFor(() =>
      expect(savedSelection).toMatchObject({ joyplotReverse: true, piReverse: true }),
    )
  })

  test("limits the visible range independently for Joyplot and Pi Lab", async () => {
    renderGallery()
    await waitFor(() =>
      expect(screen.getByTestId("settings-app-icon-limit-visible-range")).toBeTruthy(),
    )
    const limit = screen.getByTestId("settings-app-icon-limit-visible-range") as HTMLInputElement
    expect(limit.checked).toBe(false)

    fireEvent.click(limit)
    expect(limit.checked).toBe(true)
    await expectPreview("joyplot-25-magma-limited-expanded.png")

    fireEvent.change(screen.getByTestId("settings-app-icon-family"), { target: { value: "pi" } })
    expect(limit.checked).toBe(false)
    fireEvent.click(limit)
    expect(limit.checked).toBe(true)
    await expectPreview("pi-helvetica-neue-medium-viridis-limited.png")

    fireEvent.change(screen.getByTestId("settings-app-icon-family"), {
      target: { value: "joyplot" },
    })
    expect(limit.checked).toBe(true)
    await waitFor(() =>
      expect(savedSelection).toMatchObject({
        joyplotLimitVisibleRange: true,
        piLimitVisibleRange: true,
      }),
    )
  })

  test("stars exact icon setups and lists the newest favorite first", async () => {
    renderGallery()
    await waitFor(() => expect(screen.getByTestId("settings-app-icon-favorite")).toBeTruthy())
    const favorite = screen.getByTestId("settings-app-icon-favorite")
    const favorites = screen.getByTestId("settings-app-icon-favorites") as HTMLSelectElement
    expect(favorite.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(favorite)
    expect(favorite.getAttribute("aria-pressed")).toBe("true")
    expect(favorites.options).toHaveLength(2)
    expect(favorites.options[1]?.textContent).toContain("Joyplot 25")
    expect(favorites.options[1]?.textContent).toContain("Magma")
    expect(favorites.options[1]?.textContent).toContain("Expanded")
    expect(favorites.options[1]?.textContent).toContain("Forward")
    expect(favorites.options[1]?.textContent).toContain("Full range")

    fireEvent.click(screen.getByTestId("settings-app-icon-reverse"))
    expect(favorite.getAttribute("aria-pressed")).toBe("false")
    expect(favorites.value).toBe("")
    fireEvent.click(favorite)
    expect(favorites.options).toHaveLength(3)
    expect(favorites.options[1]?.textContent).toContain("Reversed")
    expect(favorites.options[2]?.textContent).toContain("Forward")
    await waitFor(() => expect(savedSelection.favoriteIcons).toHaveLength(2))

    fireEvent.change(favorites, { target: { value: "1" } })
    expect((screen.getByTestId("settings-app-icon-reverse") as HTMLInputElement).checked).toBe(
      false,
    )
    expect(favorite.getAttribute("aria-pressed")).toBe("true")
    await expectPreview("joyplot-25-magma-expanded.png")
    fireEvent.click(favorite)
    expect(favorite.getAttribute("aria-pressed")).toBe("false")
    await waitFor(() => expect(savedSelection.favoriteIcons).toHaveLength(1))
  })

  test("recalls full setups across Joyplot and Pi Lab without changing the inactive family", async () => {
    renderGallery()
    await waitFor(() => expect(screen.getByTestId("settings-app-icon-favorites")).toBeTruthy())
    const favorites = screen.getByTestId("settings-app-icon-favorites") as HTMLSelectElement
    const star = screen.getByTestId("settings-app-icon-favorite")
    fireEvent.change(screen.getByTestId("settings-app-icon-style"), { target: { value: "38" } })
    fireEvent.change(screen.getByTestId("settings-app-icon-palette"), {
      target: { value: "plasma" },
    })
    fireEvent.click(screen.getByTestId("settings-app-icon-limit-visible-range"))
    fireEvent.click(star)

    fireEvent.change(screen.getByTestId("settings-app-icon-family"), { target: { value: "pi" } })
    fireEvent.change(screen.getByTestId("settings-app-icon-font"), {
      target: { value: "didot-bold" },
    })
    fireEvent.change(screen.getByTestId("settings-app-icon-palette"), {
      target: { value: "magma-iris" },
    })
    fireEvent.click(screen.getByTestId("settings-app-icon-reverse"))
    fireEvent.click(star)
    expect(favorites.options[1]?.textContent).toContain("Pi Lab")
    expect(favorites.options[1]?.textContent).toContain("Didot")
    expect(favorites.options[1]?.textContent).toContain("Reversed")
    expect(favorites.options[2]?.textContent).toContain("Joyplot 38")

    fireEvent.change(favorites, { target: { value: "1" } })
    expect(screen.getByTestId("settings-app-icon-family")).toHaveProperty("value", "joyplot")
    expect(screen.getByTestId("settings-app-icon-style")).toHaveProperty("value", "38")
    expect(screen.getByTestId("settings-app-icon-palette")).toHaveProperty("value", "plasma")
    expect(
      (screen.getByTestId("settings-app-icon-limit-visible-range") as HTMLInputElement).checked,
    ).toBe(true)
    await expectPreview("joyplot-38-plasma-limited-expanded.png")
    await waitFor(() =>
      expect(savedSelection).toMatchObject({ piFont: "didot-bold", piPalette: "magma-iris" }),
    )
  })

  test("omits discrete theme choices", async () => {
    renderGallery()
    await waitFor(() => expect(screen.getByTestId("settings-app-icon-palette")).toBeTruthy())
    const themes = screen.getByTestId("settings-app-icon-palette") as HTMLSelectElement
    expect([...themes.options].map((option) => option.value)).not.toContain("Pastel1")
    expect([...themes.options].map((option) => option.value)).not.toContain("flag")
    expect([...themes.options].map((option) => option.value)).not.toContain("prism")
    expect(themes.options).toHaveLength(70)
  })

  test("every Pi font remains available one at a time", async () => {
    renderGallery()
    await waitFor(() => expect(screen.getByTestId("settings-app-icon-style")).toBeTruthy())
    fireEvent.change(screen.getByTestId("settings-app-icon-family"), { target: { value: "pi" } })
    expect(PI_ICON_FONTS).toHaveLength(12)
    const fonts = screen.getByTestId("settings-app-icon-font") as HTMLSelectElement
    expect([...fonts.options].map((option) => option.value)).toEqual(
      PI_ICON_FONTS.map((font) => font.id),
    )
    fireEvent.click(screen.getByTestId("settings-app-icon-previous"))
    expect(fonts.value).toBe("futura-medium")
  })

  test("reports a failed icon update and keeps the last saved choice", async () => {
    setIcon.mockRejectedValueOnce(new Error("Could not update icon"))
    renderGallery()
    await waitFor(() => expect(screen.getByTestId("settings-app-icon-style")).toBeTruthy())

    fireEvent.change(screen.getByTestId("settings-app-icon-style"), { target: { value: "33" } })
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Could not update icon"),
    )
    expect(screen.getByTestId("settings-app-icon-style")).toHaveProperty("value", "25")
  })

  test("translates its heading when language changes", () => {
    renderGallery()
    act(() => setInterfaceLanguage("es"))
    expect(screen.getByText("Icono de la aplicación")).toBeTruthy()
    act(() => setInterfaceLanguage("en"))
  })
})
