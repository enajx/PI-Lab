import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { AppProviders } from "../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../test/fakeTrpcClient"
import { OverleafSettings } from "./OverleafSettings"

/** Overleaf Settings with mocked RPC; token storage itself is tested in the main process. */
function renderSettings(handlers: FakeHandlers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AppProviders client={createFakeTrpcClient(handlers)} queryClient={queryClient}>
      <OverleafSettings />
    </AppProviders>,
  )
}

describe("Overleaf Settings (mocked RPC)", () => {
  it("replaces and removes the saved token", async () => {
    let configured = true
    const set = vi.fn(() => {
      configured = true
    })
    const clear = vi.fn(() => {
      configured = false
    })
    renderSettings({
      "paper.token.status": () => ({ configured }),
      "paper.token.set": set,
      "paper.token.clear": clear,
      "settings.get": () => ({ editor: DEFAULT_EDITOR_SETTINGS }),
    })
    await waitFor(() =>
      expect(screen.getByTestId("settings-overleaf-token-state").textContent).toBe("Saved"),
    )
    fireEvent.change(screen.getByTestId("settings-overleaf-token"), {
      target: { value: "olp_new" },
    })
    fireEvent.click(screen.getByTestId("settings-overleaf-token-save"))
    await waitFor(() => expect(set).toHaveBeenCalledWith({ token: "olp_new" }))
    fireEvent.click(screen.getByTestId("settings-overleaf-token-remove"))
    await waitFor(() => expect(clear).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByTestId("settings-overleaf-token-state").textContent).toContain(
        "Not saved",
      ),
    )
  })

  it("turns the commit question back on", async () => {
    const update = vi.fn(() => ({}))
    renderSettings({
      "paper.token.status": () => ({ configured: false }),
      "settings.get": () => ({
        editor: { ...DEFAULT_EDITOR_SETTINGS, confirmOverleafCommit: false },
      }),
      "settings.updateEditor": update,
    })
    await waitFor(() =>
      expect(
        screen.getByTestId("settings-overleaf-confirm-commit").getAttribute("data-checked"),
      ).toBe("false"),
    )
    fireEvent.click(screen.getByTestId("settings-overleaf-confirm-commit"))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ confirmOverleafCommit: true }))
  })
})
