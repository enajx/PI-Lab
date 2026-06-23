import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { AppProviders } from "../../../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../../../test/fakeTrpcClient"
import { ScholarSearch } from "./ScholarSearch"

/**
 * Component test for the Semantic Scholar search panel (AGENTS.md §14). jsdom +
 * a fake tRPC client: the search query only runs after the user submits, so we
 * type a term, submit, and assert the parsed results render as `scholar-result`
 * cards.
 */
function renderSearch(handlers: FakeHandlers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <ScholarSearch />
    </AppProviders>,
  )
}

describe("ScholarSearch", () => {
  test("idle until a query is submitted", () => {
    renderSearch({})
    expect(screen.getByTestId("scholar-search-idle")).toBeTruthy()
    expect(screen.queryByTestId("scholar-result")).toBeNull()
  })

  test("renders results after a submitted search", async () => {
    renderSearch({
      "science.library.searchPapers": (input) => {
        expect((input as { query: string }).query).toBe("resnet")
        return {
          ok: true,
          papers: [
            {
              id: "p1",
              title: "Deep Residual Learning",
              authors: ["He", "Zhang"],
              year: 2016,
              itemType: "paper",
            },
          ],
        }
      },
    })

    fireEvent.change(screen.getByTestId("scholar-search-input"), { target: { value: "resnet" } })
    fireEvent.click(screen.getByTestId("scholar-search-submit"))

    await waitFor(() => {
      expect(screen.getByTestId("scholar-result")).toBeTruthy()
    })
    expect(screen.getByTestId("library-item-title").textContent).toBe("Deep Residual Learning")
  })

  test("surfaces a search error", async () => {
    renderSearch({
      "science.library.searchPapers": () => ({ ok: false, message: "Semantic Scholar 429" }),
    })
    fireEvent.change(screen.getByTestId("scholar-search-input"), { target: { value: "x" } })
    fireEvent.click(screen.getByTestId("scholar-search-submit"))
    await waitFor(() => {
      expect(screen.getByTestId("scholar-search-error").textContent).toContain("429")
    })
  })
})
