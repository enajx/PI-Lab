import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandler } from "../../../test/fakeTrpcClient"
import { QuickOpen } from "./QuickOpen"

function renderQuickOpen(search: FakeHandler) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({
    "files.search": search,
    "projects.list": () => [],
  })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <QuickOpen workspaceId="ws-1" onOpenFile={vi.fn()} onClose={vi.fn()} />
    </AppProviders>,
  )
}

describe("QuickOpen search status", () => {
  test("shows skipped child paths with matching files", async () => {
    renderQuickOpen(() => ({
      hits: [{ relPath: "src/main.py", score: 10 }],
      partial: true,
      skipped: ["private-data"],
    }))
    fireEvent.change(screen.getByTestId("quick-open-input"), { target: { value: "main" } })
    expect(await screen.findByTestId("quick-open-result")).toBeTruthy()
    expect(screen.getByTestId("quick-open-partial").textContent).toContain("private-data")
  })

  test("shows search failure and does not query files in global scope", async () => {
    const search = vi.fn(() => {
      throw new Error("disk failure")
    })
    renderQuickOpen(search)
    fireEvent.change(screen.getByTestId("quick-open-input"), { target: { value: "main" } })
    expect(await screen.findByTestId("quick-open-error")).toBeTruthy()
    expect(search).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByTestId("quick-open-input"), { key: "Tab" })
    fireEvent.change(screen.getByTestId("quick-open-input"), { target: { value: "other" } })
    await waitFor(() =>
      expect(screen.getByTestId("quick-open-scope").textContent).toContain("All projects"),
    )
    await new Promise((resolve) => setTimeout(resolve, 180))
    expect(search).toHaveBeenCalledTimes(1)
  })
})
