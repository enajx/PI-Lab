import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { expect, test, vi } from "vitest"
import { AppProviders } from "../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../test/fakeTrpcClient"
import { PapersFolderSettings } from "./PapersFolderSettings"

/** Papers folder Settings with mocked RPC; the folder itself is used by the `paper` router tests. */
function renderSettings(handlers: FakeHandlers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AppProviders client={createFakeTrpcClient(handlers)} queryClient={queryClient}>
      <PapersFolderSettings />
    </AppProviders>,
  )
}

test("the papers folder can be changed, by typing or with Choose…, and asking can be turned off", async () => {
  const updateEditor = vi.fn(() => DEFAULT_EDITOR_SETTINGS)
  renderSettings({
    "settings.get": () => ({ editor: DEFAULT_EDITOR_SETTINGS }),
    "settings.updateEditor": updateEditor,
    "system.homeDir": () => "/Users/me",
    "system.pickDirectory": () => "/Users/me/Research/papers",
  })
  const field = (await screen.findByTestId("settings-papers-folder")) as HTMLInputElement
  await waitFor(() => expect(field.value).toBe("~/Papers"))
  fireEvent.change(field, { target: { value: "~/Writing" } })
  fireEvent.click(screen.getByTestId("settings-papers-folder-save"))
  await waitFor(() => expect(updateEditor).toHaveBeenCalledWith({ papersFolder: "~/Writing" }))
  fireEvent.click(screen.getByTestId("settings-papers-folder-choose"))
  await waitFor(() =>
    expect(updateEditor).toHaveBeenCalledWith({ papersFolder: "~/Research/papers" }),
  )
  fireEvent.click(screen.getByTestId("settings-papers-folder-ask"))
  await waitFor(() => expect(updateEditor).toHaveBeenCalledWith({ askPapersFolder: false }))
})
