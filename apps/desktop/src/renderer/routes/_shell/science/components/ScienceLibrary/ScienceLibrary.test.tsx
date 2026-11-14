import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"
import { setInterfaceLanguage } from "../../../../../i18n/language"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { ScienceLibrary } from "./ScienceLibrary"

/**
 * Component test for the Library science tab. The tab renders
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
  afterEach(() => {
    setInterfaceLanguage("en")
    window.localStorage.clear()
  })

  test("shows the source choice in the selected interface language", async () => {
    setInterfaceLanguage("es")
    renderLibrary({
      "science.library.getStatus": () => ({ connected: false }),
      "science.library.detectLocal": () => ({ reachable: true }),
    })
    expect(await screen.findByText("Elige una fuente para la biblioteca")).toBeTruthy()
    expect(screen.getByText("Explora tu biblioteca Zotero o una carpeta de PDF")).toBeTruthy()
  })

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
    expect(screen.getByTestId("library-disconnect").textContent).toBe("Unlink Zotero")
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

  /** A connected folder library whose "All items" lists one Markdown note and one PDF. */
  const viewerHandlers: FakeHandlers = {
    "science.library.getStatus": () => ({
      connected: true,
      kind: "folder",
      folderPath: "/papers/neuro",
      canWrite: false,
    }),
    "science.library.listCollections": () => ({ ok: true, collections: [] }),
    "science.library.listItems": () => ({
      ok: true,
      items: [
        { id: "notes.md", title: "Notes", authors: [] },
        { id: "other.md", title: "Other", authors: [] },
      ],
    }),
    "science.library.resolveFile": (input) => ({
      ok: true,
      path: `/papers/neuro/${(input as { itemId: string }).itemId}`,
      kind: "markdown",
      size: 100,
      limitBytes: 20 * 1024 * 1024,
    }),
    "science.library.readText": (input) => `# Heading of ${(input as { path: string }).path}`,
  }

  test("stays centered until a file opens; then shows the viewer tab on the right", async () => {
    renderLibrary(viewerHandlers)
    fireEvent.click(await screen.findByTestId("library-all-items"))
    expect(screen.queryByTestId("library-viewer")).toBeNull()
    expect(screen.getByTestId("library-list-pane").getAttribute("data-split")).toBeNull()

    fireEvent.click((await screen.findAllByTestId("library-item"))[0] as Element)
    expect(await screen.findByText("Heading of /papers/neuro/notes.md")).toBeTruthy()
    expect(screen.getByTestId("library-list-pane").getAttribute("data-split")).toBe("true")
    // The browser kept its place (All items), it was not remounted.
    expect(screen.getByTestId("library-breadcrumb").textContent).toContain("All items")

    // A second file opens a second tab; opening the first again switches back to it.
    fireEvent.click(screen.getAllByTestId("library-item")[1] as Element)
    expect(await screen.findByText("Heading of /papers/neuro/other.md")).toBeTruthy()
    fireEvent.click(screen.getAllByTestId("library-item")[0] as Element)
    expect(await screen.findByText("Heading of /papers/neuro/notes.md")).toBeTruthy()
    expect(screen.getAllByTestId("library-viewer-tab")).toHaveLength(2)

    // Closing every tab returns to the centered layout.
    for (const close of screen.getAllByTestId("library-viewer-tab-close")) fireEvent.click(close)
    await waitFor(() => expect(screen.queryByTestId("library-viewer")).toBeNull())
    expect(screen.getByTestId("library-list-pane").getAttribute("data-split")).toBeNull()
  })

  test("open tabs come back after the Library is opened again", async () => {
    const first = renderLibrary(viewerHandlers)
    fireEvent.click(await screen.findByTestId("library-all-items"))
    fireEvent.click((await screen.findAllByTestId("library-item"))[0] as Element)
    expect(await screen.findByText("Heading of /papers/neuro/notes.md")).toBeTruthy()
    first.unmount()

    renderLibrary(viewerHandlers)
    expect(await screen.findByText("Heading of /papers/neuro/notes.md")).toBeTruthy()
    expect(screen.getAllByTestId("library-viewer-tab")).toHaveLength(1)
  })

  test("a tab stays loaded after switching away and back", async () => {
    renderLibrary(viewerHandlers)
    fireEvent.click(await screen.findByTestId("library-all-items"))
    fireEvent.click((await screen.findAllByTestId("library-item"))[0] as Element)
    expect(await screen.findByText("Heading of /papers/neuro/notes.md")).toBeTruthy()
    fireEvent.click(screen.getAllByTestId("library-item")[1] as Element)
    expect(await screen.findByText("Heading of /papers/neuro/other.md")).toBeTruthy()
    // The first tab's content is still in the page (hidden), not read again.
    expect(screen.getByText("Heading of /papers/neuro/notes.md")).toBeTruthy()
  })

  test("a file over the limit shows its size and loads on Load anyway", async () => {
    const reads: unknown[] = []
    renderLibrary({
      ...viewerHandlers,
      "science.library.resolveFile": () => ({
        ok: true,
        path: "/papers/neuro/notes.md",
        kind: "markdown",
        size: 30 * 1024 * 1024,
        limitBytes: 20 * 1024 * 1024,
      }),
      "science.library.readText": (input) => {
        reads.push(input)
        return "# Big notes"
      },
    })
    fireEvent.click(await screen.findByTestId("library-all-items"))
    fireEvent.click((await screen.findAllByTestId("library-item"))[0] as Element)
    expect((await screen.findByTestId("library-viewer-large")).textContent).toContain(
      "This file is 30.0 MB, over the viewer's 20.0 MB limit.",
    )
    expect(reads).toEqual([])
    fireEvent.click(screen.getByTestId("library-viewer-load-anyway"))
    expect(await screen.findByText("Big notes")).toBeTruthy()
    expect(reads).toEqual([{ path: "/papers/neuro/notes.md", allowLarge: true }])
  })
})
