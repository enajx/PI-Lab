import { QueryClient } from "@tanstack/react-query"
import { describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../../test/fakeTrpcClient"
import { fireEvent, render, screen, waitFor, within } from "../../../../test/render"
import { DocumentToolsSection } from "./DocumentToolsSection"

/** Settings > Document tools with a faked tRPC client (mocked main process). */

const IDLE = { state: "idle", progress: null, message: "", error: null }

describe("DocumentToolsSection", () => {
  test("shows the path and version of a found tool, and Install for a missing one", async () => {
    const install = vi.fn(() => ({ started: true }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AppProviders
        client={createFakeTrpcClient({
          "documents.tools": () => ({
            quarto: { path: "/usr/local/bin/quarto", version: "1.11.9", error: null },
            myst: null,
            installation: { quarto: IDLE, myst: IDLE },
          }),
          "documents.install": install,
        })}
        queryClient={queryClient}
      >
        <DocumentToolsSection />
      </AppProviders>,
    )

    const quarto = await screen.findByTestId("settings-document-tool-quarto")
    expect(within(quarto).getByText("/usr/local/bin/quarto")).toBeTruthy()
    expect(within(quarto).getByText("1.11.9")).toBeTruthy()
    expect(within(quarto).queryByRole("button", { name: "Install Quarto" })).toBeNull()

    const myst = screen.getByTestId("settings-document-tool-myst")
    expect(within(myst).getByText("Not found")).toBeTruthy()
    fireEvent.click(within(myst).getByRole("button", { name: "Install MyST" }))
    await waitFor(() => expect(install).toHaveBeenCalledWith({ tool: "myst" }))
  })
})
