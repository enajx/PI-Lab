import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { AppProviders } from "../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../test/fakeTrpcClient"
import { LatexSection } from "./LatexSection"

const initialStatus = {
  provider: "bundled",
  bundled: { available: true, version: "Tectonic 0.15", path: "/app/tectonic", error: null },
  system: { available: false, version: null, pdflatexPath: null, latexmkPath: null, error: null },
  installation: { state: "idle", progress: null, message: "", error: null },
}

/** Exercise Settings with mocked RPC; installer and compiler execution are covered separately. */
function renderSection(handlers: FakeHandlers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AppProviders client={createFakeTrpcClient(handlers)} queryClient={queryClient}>
      <LatexSection />
    </AppProviders>,
  )
}

describe("LaTeX Settings (mocked RPC)", () => {
  it("shows global provider and tools, and saves the selected provider", async () => {
    let provider = "bundled"
    const update = vi.fn((input: unknown) => {
      provider = (input as { latexProvider: string }).latexProvider
      return { latexProvider: provider }
    })
    renderSection({
      "latex.status": () => ({ ...initialStatus, provider }),
      "settings.updateEditor": update,
    })
    expect(await screen.findByText("Tectonic 0.15")).toBeTruthy()
    expect(screen.getByText("/app/tectonic")).toBeTruthy()
    expect(screen.getByText(/applies to all projects/i)).toBeTruthy()
    fireEvent.change(screen.getByLabelText("LaTeX provider"), { target: { value: "system" } })
    await waitFor(() => expect(update).toHaveBeenCalledWith({ latexProvider: "system" }))
    await waitFor(() =>
      expect((screen.getByLabelText("LaTeX provider") as HTMLSelectElement).value).toBe("system"),
    )
  })

  it("downloads only after a click, shows progress, then uses the installed provider", async () => {
    let installed = false
    let active = false
    let polls = 0
    const install = vi.fn(() => {
      active = true
      return { started: true }
    })
    renderSection({
      "latex.install": install,
      "latex.status": () => {
        if (active && ++polls > 1) installed = true
        return {
          ...initialStatus,
          provider: installed ? "system" : "bundled",
          installation: installed
            ? { state: "complete", progress: 100, message: "PDFLaTeX installed", error: null }
            : active
              ? { state: "downloading", progress: 25, message: "Downloading TinyTeX", error: null }
              : initialStatus.installation,
        }
      },
    })
    const button = await screen.findByRole("button", { name: "Install PDFLaTeX" })
    expect(install).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(await screen.findByText("Downloading TinyTeX")).toBeTruthy()
    expect((screen.getByRole("progressbar") as HTMLProgressElement).value).toBe(25)
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(await screen.findByText("PDFLaTeX installed")).toBeTruthy()
    expect((screen.getByLabelText("LaTeX provider") as HTMLSelectElement).value).toBe("system")
  })

  it("shows installation and request errors", async () => {
    renderSection({
      "latex.status": () => ({
        ...initialStatus,
        installation: {
          state: "failed",
          progress: null,
          message: "Installation failed",
          error: "Disk is full",
        },
      }),
      "latex.install": () => {
        throw new Error("Download unavailable")
      },
    })
    expect(await screen.findByText("Disk is full")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Install PDFLaTeX" }))
    expect(await screen.findByText("Download unavailable")).toBeTruthy()
  })

  it("shows provider save failures and keeps the saved choice", async () => {
    renderSection({
      "latex.status": () => initialStatus,
      "settings.updateEditor": () => {
        throw new Error("Settings could not be saved")
      },
    })
    const provider = await screen.findByLabelText("LaTeX provider")
    fireEvent.change(provider, { target: { value: "system" } })
    expect(await screen.findByText("Settings could not be saved")).toBeTruthy()
    expect((provider as HTMLSelectElement).value).toBe("bundled")
  })

  it("reports tool discovery failures", async () => {
    renderSection({
      "latex.status": () => {
        throw new Error("Tool discovery failed")
      },
    })
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Tool discovery failed")
  })
})
