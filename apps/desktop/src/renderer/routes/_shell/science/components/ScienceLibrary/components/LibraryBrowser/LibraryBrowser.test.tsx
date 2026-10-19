import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../../../test/fakeTrpcClient"
import { LibraryBrowser } from "./LibraryBrowser"

/**
 * Component test for the source-agnostic collections browser:
 * collections-first rendering, the folder "Open" action, the truncation banner, and the
 * keyboard cursor (↓/↑ move, ⌘→ enters, ⌘←/⌘↑ go back, ⌘↓ no-ops).
 */
function collection(key: string, name: string, itemCount = 0) {
  return { key, name, itemCount, subcollectionCount: 0 }
}
function paper(id: string, title: string) {
  return { id, title, authors: [] as string[], itemType: "PDF" }
}

function renderBrowser(
  props: { kind: "zotero" | "folder"; canWrite: boolean; rootLabel: string },
  handlers: FakeHandlers,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const client = createFakeTrpcClient(handlers)
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <LibraryBrowser {...props} />
    </AppProviders>,
  )
}

/** Two top-level collections at root; C1 (Methods) has one sub-collection (C1a) plus items. */
const browseHandlers: FakeHandlers = {
  "science.library.listCollections": (input) => {
    const parentKey = (input as { parentKey?: string } | undefined)?.parentKey
    if (parentKey === "C1") return { ok: true, collections: [collection("C1a", "Sub-methods")] }
    if (parentKey) return { ok: true, collections: [] }
    return { ok: true, collections: [collection("C1", "Methods", 2), collection("C2", "Results")] }
  },
  "science.library.listItems": (input) => {
    const key = (input as { collectionKey?: string } | undefined)?.collectionKey
    if (key === "C1") return { ok: true, items: [paper("a/p1.pdf", "P1"), paper("a/p2.pdf", "P2")] }
    return { ok: true, items: [paper("top.pdf", "Top")] }
  },
}

describe("LibraryBrowser", () => {
  test("shows a Zotero error and recovers on manual Refresh", async () => {
    let available = false
    const listCollections = vi.fn((_input: unknown) =>
      available
        ? { ok: true, collections: [collection("C1", "Recovered")] }
        : { ok: false, reason: "error", message: "Zotero is unavailable" },
    )
    renderBrowser(
      { kind: "zotero", canWrite: false, rootLabel: "Zotero library" },
      { "science.library.listCollections": listCollections },
    )
    await waitFor(() => expect(screen.getByText("Zotero is unavailable")).toBeTruthy())
    expect(listCollections).toHaveBeenCalledTimes(1)

    available = true
    fireEvent.click(screen.getByTestId("library-refresh"))
    await waitFor(() => expect(screen.getByText("Recovered")).toBeTruthy())
    expect(
      listCollections.mock.calls.filter(
        ([input]) => (input as { parentKey?: string } | undefined)?.parentKey === undefined,
      ).length,
    ).toBe(2)
  })

  test("renders the root view: All items + collections, with the cursor on All items", async () => {
    renderBrowser({ kind: "zotero", canWrite: false, rootLabel: "Zotero library" }, browseHandlers)
    await waitFor(() => {
      expect(screen.getAllByTestId("library-collection")).toHaveLength(2)
    })
    expect(screen.getByTestId("library-crumb-root").textContent).toBe("Zotero library")
    expect(screen.getByTestId("library-all-items").getAttribute("data-selected")).toBe("true")
  })

  test("ArrowDown moves the cursor onto the first collection", async () => {
    renderBrowser({ kind: "zotero", canWrite: false, rootLabel: "Zotero library" }, browseHandlers)
    await waitFor(() => expect(screen.getAllByTestId("library-collection")).toHaveLength(2))
    fireEvent.keyDown(screen.getByTestId("library-browser"), { key: "ArrowDown" })
    expect(screen.getAllByTestId("library-collection")[0]?.getAttribute("data-selected")).toBe(
      "true",
    )
    expect(screen.getByTestId("library-all-items").getAttribute("data-selected")).toBeNull()
  })

  test("⌘→ enters the selected collection; ⌘← goes back to root", async () => {
    renderBrowser({ kind: "zotero", canWrite: false, rootLabel: "Zotero library" }, browseHandlers)
    await waitFor(() => expect(screen.getAllByTestId("library-collection")).toHaveLength(2))

    fireEvent.keyDown(screen.getByTestId("library-browser"), { key: "ArrowDown" }) // → C1
    fireEvent.keyDown(screen.getByTestId("library-browser"), { key: "ArrowRight", metaKey: true })
    await waitFor(() => {
      expect(screen.getByTestId("library-breadcrumb").textContent).toContain("Methods")
    })
    // The collection's items load asynchronously after navigation.
    await waitFor(() => {
      expect(screen.getAllByTestId("library-item")).toHaveLength(2)
    })

    fireEvent.keyDown(screen.getByTestId("library-browser"), { key: "ArrowLeft", metaKey: true })
    await waitFor(() => {
      expect(screen.getByTestId("library-all-items")).toBeTruthy()
    })
    expect(screen.getByTestId("library-breadcrumb").textContent).not.toContain("Methods")
  })

  test("⌘↓ activates the selected row, same as ⌘→", async () => {
    renderBrowser({ kind: "zotero", canWrite: false, rootLabel: "Zotero library" }, browseHandlers)
    await waitFor(() => expect(screen.getAllByTestId("library-collection")).toHaveLength(2))
    fireEvent.keyDown(screen.getByTestId("library-browser"), { key: "ArrowDown" }) // → C1
    fireEvent.keyDown(screen.getByTestId("library-browser"), { key: "ArrowDown", metaKey: true }) // ⌘↓ enters C1
    await waitFor(() => {
      expect(screen.getByTestId("library-breadcrumb").textContent).toContain("Methods")
    })
  })

  test("folder items expose an Open action that calls openItem", async () => {
    const openItem = vi.fn(() => ({ ok: true }))
    renderBrowser(
      { kind: "folder", canWrite: false, rootLabel: "neuro" },
      { ...browseHandlers, "science.library.openItem": openItem },
    )
    await waitFor(() => expect(screen.getByTestId("library-all-items")).toBeTruthy())
    fireEvent.click(screen.getByTestId("library-all-items")) // → All items view
    await waitFor(() => expect(screen.getAllByTestId("library-item")).toHaveLength(1))
    // Folder items get "Open", never "Attach".
    expect(screen.queryByTestId("library-item-attach")).toBeNull()
    fireEvent.click(screen.getByTestId("library-item-open"))
    await waitFor(() => {
      expect(openItem).toHaveBeenCalledWith({ path: "top.pdf" })
    })
  })

  test("⌘→ on a folder paper opens it via openItem (keyboard)", async () => {
    const openItem = vi.fn(() => ({ ok: true }))
    renderBrowser(
      { kind: "folder", canWrite: false, rootLabel: "neuro" },
      { ...browseHandlers, "science.library.openItem": openItem },
    )
    await waitFor(() => expect(screen.getByTestId("library-all-items")).toBeTruthy())
    fireEvent.click(screen.getByTestId("library-all-items")) // → All items (papers shown)
    await waitFor(() => expect(screen.getAllByTestId("library-item")).toHaveLength(1))
    // Cursor starts on the first paper; ⌘→ activates it.
    fireEvent.keyDown(screen.getByTestId("library-browser"), { key: "ArrowRight", metaKey: true })
    await waitFor(() => {
      expect(openItem).toHaveBeenCalledWith({ path: "top.pdf" })
    })
  })

  test("Enter on a selected folder paper opens its local copy via openItem", async () => {
    const openItem = vi.fn(() => ({ ok: true }))
    renderBrowser(
      { kind: "folder", canWrite: false, rootLabel: "neuro" },
      { ...browseHandlers, "science.library.openItem": openItem },
    )
    await waitFor(() => expect(screen.getByTestId("library-all-items")).toBeTruthy())
    fireEvent.click(screen.getByTestId("library-all-items")) // → All items (cursor lands on the paper)
    await waitFor(() => expect(screen.getAllByTestId("library-item")).toHaveLength(1))
    fireEvent.keyDown(screen.getByTestId("library-browser"), { key: "Enter" })
    await waitFor(() => {
      expect(openItem).toHaveBeenCalledWith({ path: "top.pdf" })
    })
  })

  test("⌘↵ on a selected folder paper also opens it externally", async () => {
    const openItem = vi.fn(() => ({ ok: true }))
    renderBrowser(
      { kind: "folder", canWrite: false, rootLabel: "neuro" },
      { ...browseHandlers, "science.library.openItem": openItem },
    )
    await waitFor(() => expect(screen.getByTestId("library-all-items")).toBeTruthy())
    fireEvent.click(screen.getByTestId("library-all-items"))
    await waitFor(() => expect(screen.getAllByTestId("library-item")).toHaveLength(1))
    fireEvent.keyDown(screen.getByTestId("library-browser"), { key: "Enter", metaKey: true })
    await waitFor(() => {
      expect(openItem).toHaveBeenCalledWith({ path: "top.pdf" })
    })
  })

  test("Enter on a Zotero paper opens its local copy via openZoteroItem", async () => {
    const openZoteroItem = vi.fn(() => ({ ok: true }))
    renderBrowser(
      { kind: "zotero", canWrite: false, rootLabel: "Zotero library" },
      { ...browseHandlers, "science.library.openZoteroItem": openZoteroItem },
    )
    await waitFor(() => expect(screen.getByTestId("library-all-items")).toBeTruthy())
    fireEvent.click(screen.getByTestId("library-all-items"))
    await waitFor(() => expect(screen.getAllByTestId("library-item")).toHaveLength(1))
    fireEvent.keyDown(screen.getByTestId("library-browser"), { key: "Enter" })
    await waitFor(() => {
      expect(openZoteroItem).toHaveBeenCalledWith({ itemKey: "top.pdf" })
    })
    expect(screen.queryByTestId("library-open-error")).toBeNull()
  })

  test("Enter on a Zotero paper with no local copy surfaces the resolver's message", async () => {
    const openZoteroItem = vi.fn(() => ({
      ok: false,
      reason: "no-local-file",
      message: "No local copy available (not downloaded).",
    }))
    renderBrowser(
      { kind: "zotero", canWrite: false, rootLabel: "Zotero library" },
      { ...browseHandlers, "science.library.openZoteroItem": openZoteroItem },
    )
    await waitFor(() => expect(screen.getByTestId("library-all-items")).toBeTruthy())
    fireEvent.click(screen.getByTestId("library-all-items"))
    await waitFor(() => expect(screen.getAllByTestId("library-item")).toHaveLength(1))
    fireEvent.keyDown(screen.getByTestId("library-browser"), { key: "Enter" })
    await waitFor(() => {
      expect(screen.getByTestId("library-open-error").textContent).toContain(
        "No local copy available",
      )
    })
    expect(openZoteroItem).toHaveBeenCalledWith({ itemKey: "top.pdf" })
  })

  test("Enter on a selected collection drills into it (universal activate)", async () => {
    renderBrowser({ kind: "zotero", canWrite: false, rootLabel: "Zotero library" }, browseHandlers)
    await waitFor(() => expect(screen.getAllByTestId("library-collection")).toHaveLength(2))
    fireEvent.keyDown(screen.getByTestId("library-browser"), { key: "ArrowDown" }) // → C1 (Methods)
    fireEvent.keyDown(screen.getByTestId("library-browser"), { key: "Enter" })
    await waitFor(() => {
      expect(screen.getByTestId("library-breadcrumb").textContent).toContain("Methods")
    })
  })

  test("Enter on the 'All items' row opens the All-items view", async () => {
    renderBrowser({ kind: "zotero", canWrite: false, rootLabel: "Zotero library" }, browseHandlers)
    await waitFor(() => expect(screen.getByTestId("library-all-items")).toBeTruthy())
    // The cursor starts on "All items"; Enter activates it.
    fireEvent.keyDown(screen.getByTestId("library-browser"), { key: "Enter" })
    await waitFor(() => {
      expect(screen.getByTestId("library-breadcrumb").textContent).toContain("All items")
    })
  })

  test("a failed open surfaces the error message inline", async () => {
    const openItem = vi.fn(() => ({ ok: false, reason: "error", message: "File is gone." }))
    renderBrowser(
      { kind: "folder", canWrite: false, rootLabel: "neuro" },
      { ...browseHandlers, "science.library.openItem": openItem },
    )
    await waitFor(() => expect(screen.getByTestId("library-all-items")).toBeTruthy())
    fireEvent.click(screen.getByTestId("library-all-items"))
    await waitFor(() => expect(screen.getAllByTestId("library-item")).toHaveLength(1))
    fireEvent.keyDown(screen.getByTestId("library-browser"), { key: "Enter" })
    await waitFor(() => {
      expect(screen.getByTestId("library-open-error").textContent).toContain("File is gone.")
    })
  })

  test("⌘F opens the collection finder; picking one drills in", async () => {
    renderBrowser({ kind: "zotero", canWrite: false, rootLabel: "Zotero library" }, browseHandlers)
    await waitFor(() => expect(screen.getAllByTestId("library-collection")).toHaveLength(2))

    // The quick-open shortcut (⌘F) opens the finder over this level's collections.
    fireEvent.keyDown(window, { key: "f", metaKey: true })
    expect(screen.getByTestId("quick-find")).toBeTruthy()
    // Order: this level's collections (`coll:`), then their sub-collections (`deep:`), then
    // papers (`paper:`, when shown). The deep child appears once its query resolves.
    await waitFor(() => {
      expect(
        screen.getAllByTestId("quick-find-item").map((el) => el.getAttribute("data-find-id")),
      ).toEqual(["coll:C1", "coll:C2", "deep:C1a"])
    })

    // Picking a collection drills into it, exactly as clicking its row would.
    const finderItems = screen.getAllByTestId("quick-find-item")
    const results = finderItems.find((el) => el.getAttribute("data-find-id") === "coll:C2")
    if (!results) throw new Error("expected the Results collection in the finder")
    fireEvent.click(results)
    await waitFor(() => {
      expect(screen.getByTestId("library-breadcrumb").textContent).toContain("Results")
    })
    expect(screen.queryByTestId("quick-find")).toBeNull()
  })

  test("the finder offers sub-collections (deep:) and a pick drills two levels in", async () => {
    renderBrowser({ kind: "zotero", canWrite: false, rootLabel: "Zotero library" }, browseHandlers)
    await waitFor(() => expect(screen.getAllByTestId("library-collection")).toHaveLength(2))

    fireEvent.keyDown(window, { key: "f", metaKey: true })
    expect(screen.getByTestId("quick-find")).toBeTruthy()
    // The child of "Methods" shows as a `deep:` item once its query resolves.
    const deepLabel = await screen.findByText("Sub-methods")
    const deepItem = deepLabel.closest("[data-testid='quick-find-item']")
    expect(deepItem?.getAttribute("data-find-id")).toBe("deep:C1a")

    fireEvent.click(deepItem as Element)
    // Picking it drills BOTH levels at once: Methods → Sub-methods.
    await waitFor(() => {
      const crumb = screen.getByTestId("library-breadcrumb").textContent ?? ""
      expect(crumb).toContain("Methods")
      expect(crumb).toContain("Sub-methods")
    })
    expect(screen.queryByTestId("quick-find")).toBeNull()
  })

  test("⌘-arrow nav works on window even when the pane isn't focused", async () => {
    renderBrowser({ kind: "zotero", canWrite: false, rootLabel: "Zotero library" }, browseHandlers)
    await waitFor(() => expect(screen.getAllByTestId("library-collection")).toHaveLength(2))

    // Fired on `window` (not the pane): the cursor still moves off "All items" onto C1…
    fireEvent.keyDown(window, { key: "ArrowDown" })
    expect(screen.getAllByTestId("library-collection")[0]?.getAttribute("data-selected")).toBe(
      "true",
    )
    expect(screen.getByTestId("library-all-items").getAttribute("data-selected")).toBeNull()
    // …and ⌘→ on `window` drills into the selected collection.
    fireEvent.keyDown(window, { key: "ArrowRight", metaKey: true })
    await waitFor(() => {
      expect(screen.getByTestId("library-breadcrumb").textContent).toContain("Methods")
    })
  })

  test("shows the truncation note when the listing is capped", async () => {
    renderBrowser(
      { kind: "folder", canWrite: false, rootLabel: "neuro" },
      {
        ...browseHandlers,
        "science.library.listItems": () => ({
          ok: true,
          items: [paper("a.pdf", "A"), paper("b.pdf", "B")],
          truncated: true,
        }),
      },
    )
    fireEvent.click(await screen.findByTestId("library-all-items"))
    await waitFor(() => {
      expect(screen.getByTestId("library-truncated").textContent).toContain("open a subfolder")
    })
  })
})
