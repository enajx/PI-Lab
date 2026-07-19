import { QueryClient } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { ScienceLibrary } from "./ScienceLibrary"

/**
 * Component test for the Library science tab (md/engineering/testing-and-build.md). The tab renders
 * plain DOM + the hand-authored UI primitives, so jsdom suffices; we assert structure
 * only — the source chooser (disconnected) vs. the collections browser (connected).
 * Item/navigation detail lives in the LibraryBrowser test.
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

function collection(key: string, name: string, itemCount = 0, subcollectionCount = 0) {
  return { key, name, itemCount, subcollectionCount }
}

describe("ScienceLibrary", () => {
  test("shows the source chooser (three sources) when not connected", async () => {
    renderLibrary({
      "science.library.getStatus": () => ({ connected: false }),
      "science.library.detectLocal": () => ({ reachable: true }),
    })
    await waitFor(() => {
      expect(screen.getByTestId("library-source-chooser")).toBeTruthy()
    })
    expect(screen.getByTestId("zotero-chooser-local")).toBeTruthy()
    expect(screen.getByTestId("zotero-chooser-web")).toBeTruthy()
    expect(screen.getByTestId("library-source-folder")).toBeTruthy()
    // No browser while disconnected.
    expect(screen.queryByTestId("library-breadcrumb")).toBeNull()
  })

  test("renders the collections browser + a disconnect affordance when connected", async () => {
    renderLibrary({
      "science.library.getStatus": () => ({
        connected: true,
        kind: "zotero",
        mode: "web",
        libraryType: "user",
        libraryId: "1",
        canWrite: false,
      }),
      "science.library.listCollections": () => ({
        ok: true,
        collections: [collection("C1", "Methods", 3), collection("C2", "Results")],
      }),
    })

    await waitFor(() => {
      expect(screen.getAllByTestId("library-collection")).toHaveLength(2)
    })
    expect(screen.getByTestId("library-breadcrumb")).toBeTruthy()
    expect(screen.getByTestId("library-disconnect")).toBeTruthy()
    expect(screen.queryByTestId("library-source-chooser")).toBeNull()
    // Default view = collections (+ an "All items" entry), not a flat item list.
    expect(screen.getByTestId("library-all-items")).toBeTruthy()
    expect(screen.queryByTestId("library-item")).toBeNull()
  })

  test("labels the breadcrumb root with the folder name for a folder source", async () => {
    renderLibrary({
      "science.library.getStatus": () => ({
        connected: true,
        kind: "folder",
        folderPath: "/papers/neuro",
        canWrite: false,
      }),
      "science.library.listCollections": () => ({ ok: true, collections: [] }),
    })
    await waitFor(() => {
      expect(screen.getByTestId("library-crumb-root").textContent).toBe("neuro")
    })
  })

  test("shows the collections-empty hint when the library has no collections", async () => {
    renderLibrary({
      "science.library.getStatus": () => ({
        connected: true,
        kind: "zotero",
        mode: "web",
        libraryType: "user",
        libraryId: "1",
      }),
      "science.library.listCollections": () => ({ ok: true, collections: [] }),
    })
    await waitFor(() => {
      expect(screen.getByTestId("library-collections-empty")).toBeTruthy()
    })
    // "All items" remains available even with no collections.
    expect(screen.getByTestId("library-all-items")).toBeTruthy()
  })

  test("surfaces a collections error", async () => {
    renderLibrary({
      "science.library.getStatus": () => ({
        connected: true,
        kind: "zotero",
        mode: "web",
        libraryType: "user",
        libraryId: "1",
      }),
      "science.library.listCollections": () => ({
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
