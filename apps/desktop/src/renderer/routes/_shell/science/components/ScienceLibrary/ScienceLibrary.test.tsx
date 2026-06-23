import { QueryClient } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import type { LibraryPaper } from "../../../../../../main/trpc/science/library"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { ScienceLibrary } from "./ScienceLibrary"

// The renderer-facing paper shape, kept in step with the router's `LibraryPaper`.
type Paper = LibraryPaper

/**
 * Component test for the Library science tab (AGENTS.md §14). The tab renders
 * plain DOM + the hand-authored UI primitives, so jsdom suffices; we assert
 * structure only (the connect form vs. the library list + scholar search) — never
 * copy text or shadcn classes.
 */
function renderLibrary(handlers: FakeHandlers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <ScienceLibrary />
    </AppProviders>,
  )
}

function paper(overrides: Partial<Paper> & Pick<Paper, "id" | "title">): Paper {
  return { authors: [], ...overrides }
}

describe("ScienceLibrary", () => {
  test("shows the Zotero connect form when not connected", async () => {
    renderLibrary({
      "science.library.getStatus": () => ({ connected: false }),
    })
    await waitFor(() => {
      expect(screen.getByTestId("zotero-connect")).toBeTruthy()
    })
    // The library list is absent while disconnected; the scholar search is always present.
    expect(screen.queryByTestId("library-item")).toBeNull()
    expect(screen.getByTestId("scholar-search")).toBeTruthy()
  })

  test("renders the library list + a disconnect affordance when connected", async () => {
    renderLibrary({
      "science.library.getStatus": () => ({
        connected: true,
        libraryType: "user",
        libraryId: "1",
      }),
      "science.library.listItems": () => ({
        ok: true,
        items: [
          paper({
            id: "a",
            title: "Attention Is All You Need",
            authors: ["Vaswani"],
            year: 2017,
            itemType: "conferencePaper",
          }),
          paper({ id: "b", title: "Another Paper" }),
        ],
      }),
    })

    await waitFor(() => {
      expect(screen.getAllByTestId("library-item")).toHaveLength(2)
    })
    expect(screen.getByTestId("zotero-disconnect")).toBeTruthy()
    expect(screen.queryByTestId("zotero-connect")).toBeNull()
    const titles = screen.getAllByTestId("library-item-title").map((el) => el.textContent)
    expect(titles).toContain("Attention Is All You Need")
  })

  test("shows the empty state when the connected library has no items", async () => {
    renderLibrary({
      "science.library.getStatus": () => ({ connected: true, libraryType: "user", libraryId: "1" }),
      "science.library.listItems": () => ({ ok: true, items: [] }),
    })
    await waitFor(() => {
      expect(screen.getByTestId("science-library-empty")).toBeTruthy()
    })
  })

  test("surfaces a Zotero list error", async () => {
    renderLibrary({
      "science.library.getStatus": () => ({ connected: true, libraryType: "user", libraryId: "1" }),
      "science.library.listItems": () => ({
        ok: false,
        reason: "error",
        message: "Zotero API 500",
      }),
    })
    await waitFor(() => {
      expect(screen.getByTestId("library-error").textContent).toContain("500")
    })
  })
})
