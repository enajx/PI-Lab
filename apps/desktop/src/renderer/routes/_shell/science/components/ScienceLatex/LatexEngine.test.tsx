import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { LatexEngineStatusItem } from "./LatexEngine"

/**
 * Component tests for the LaTeX Editor footer's engine picker. The tRPC server
 * is a fake (mocked); the router tests cover how the engine is chosen.
 */
const idle = { state: "idle", progress: null, message: "", error: null }
const tectonic = {
  available: true,
  version: "Tectonic 0.15.0",
  name: "Tectonic",
  path: "/app/tectonic",
  error: null,
}
const texLive = {
  available: true,
  version: "pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026/Homebrew)",
  name: "TeX Live 2026",
  pdflatexPath: "/opt/homebrew/bin/pdflatex",
  latexmkPath: "/opt/homebrew/bin/latexmk",
  error: null,
}
const noSystem = {
  available: false,
  version: null,
  name: "System LaTeX",
  pdflatexPath: null,
  latexmkPath: null,
  error: "System PDFLaTeX and latexmk are required.",
}

function renderItem(handlers: FakeHandlers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AppProviders client={createFakeTrpcClient(handlers)} queryClient={queryClient}>
      <LatexEngineStatusItem />
    </AppProviders>,
  )
}

describe("LaTeX engine footer item (mocked server)", () => {
  it("shows the engine in use and switches the global engine from its menu", async () => {
    let provider = "auto"
    const update = vi.fn((input: unknown) => {
      provider = (input as { latexProvider: string }).latexProvider
      return {}
    })
    renderItem({
      "latex.status": () => ({
        provider,
        bundled: tectonic,
        system: texLive,
        engine:
          provider === "bundled"
            ? { kind: "bundled", name: "Tectonic" }
            : { kind: "system", name: "TeX Live 2026" },
        installation: idle,
      }),
      "settings.updateEditor": update,
    })
    const item = await screen.findByTestId("latex-engine")
    await waitFor(() => expect(item.textContent).toContain("TeX Live 2026"))
    fireEvent.click(item)
    const menu = screen.getByRole("menu", { name: "LaTeX engine" })
    // The menu has no Auto: it ticks the engine builds use now.
    expect(within(menu).queryByTestId("latex-engine-auto")).toBeNull()
    expect(menu.textContent).not.toContain("Auto")
    const system = within(menu).getByTestId("latex-engine-system")
    expect(system.getAttribute("aria-checked")).toBe("true")
    expect(within(menu).getByTestId("latex-engine-bundled").getAttribute("aria-checked")).toBe(
      "false",
    )
    expect(system.textContent).toContain("TeX Live 2026")
    expect((system as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(within(menu).getByTestId("latex-engine-bundled"))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ latexProvider: "bundled" }))
    await waitFor(() =>
      expect(screen.getByTestId("latex-engine").textContent).toContain("Tectonic"),
    )
  })

  it("disables System LaTeX with a reason when it is not installed, and installs TinyTeX", async () => {
    const install = vi.fn(() => ({ started: true }))
    renderItem({
      "latex.status": () => ({
        provider: "auto",
        bundled: tectonic,
        system: noSystem,
        engine: { kind: "bundled", name: "Tectonic" },
        installation: idle,
      }),
      "latex.install": install,
    })
    const item = await screen.findByTestId("latex-engine")
    await waitFor(() => expect(item.textContent).toContain("Tectonic"))
    fireEvent.click(item)
    const system = screen.getByTestId("latex-engine-system") as HTMLButtonElement
    expect(system.disabled).toBe(true)
    expect(system.textContent).toContain("Not installed")
    fireEvent.click(screen.getByTestId("latex-engine-install"))
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1))
  })

  it("lets the user install TinyTeX when a system LaTeX is already installed", async () => {
    const install = vi.fn(() => ({ started: true }))
    renderItem({
      "latex.status": () => ({
        provider: "auto",
        bundled: tectonic,
        system: texLive,
        engine: { kind: "system", name: "TeX Live 2026" },
        installation: idle,
      }),
      "latex.install": install,
    })
    const item = await screen.findByTestId("latex-engine")
    await waitFor(() => expect(item.textContent).toContain("TeX Live 2026"))
    fireEvent.click(item)
    const button = screen.getByTestId("latex-engine-install") as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1))
  })
})
