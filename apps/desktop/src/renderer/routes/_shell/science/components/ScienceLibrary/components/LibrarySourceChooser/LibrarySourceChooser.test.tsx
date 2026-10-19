import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../../../test/fakeTrpcClient"
import { LibrarySourceChooser, type LibrarySourceValues } from "./LibrarySourceChooser"

/**
 * Component test for the three-source chooser. jsdom + a fake
 * tRPC client: the live "detected" badge reads `detectLocal`, the folder card drives the
 * native `system.pickDirectory` then connects with the chosen path, and the Zotero cards
 * connect zero-config / reveal the advanced form.
 */
function renderChooser(
  onConnect: (values: LibrarySourceValues) => void,
  handlers: FakeHandlers = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const client = createFakeTrpcClient({
    "science.library.detectLocal": () => ({ reachable: false }),
    ...handlers,
  })
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <LibrarySourceChooser onConnect={onConnect} />
    </AppProviders>,
  )
}

describe("LibrarySourceChooser", () => {
  test("renders all three source cards and the live local-detection badge", async () => {
    renderChooser(vi.fn(), { "science.library.detectLocal": () => ({ reachable: true }) })
    expect(screen.getByTestId("zotero-chooser-local")).toBeTruthy()
    expect(screen.getByTestId("zotero-chooser-web")).toBeTruthy()
    expect(screen.getByTestId("library-source-folder")).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByTestId("zotero-local-detected").getAttribute("data-reachable")).toBe(
        "true",
      )
    })
  })

  test("zero-config local Zotero connects to the personal library", () => {
    const onConnect = vi.fn()
    renderChooser(onConnect)
    fireEvent.click(screen.getByTestId("zotero-use-local"))
    expect(onConnect).toHaveBeenCalledWith({
      kind: "zotero",
      mode: "local",
      libraryType: "user",
      libraryId: "0",
    })
  })

  test("the folder card picks a directory and connects to it", async () => {
    const onConnect = vi.fn()
    renderChooser(onConnect, { "system.pickDirectory": () => "/papers/neuro" })
    fireEvent.click(screen.getByTestId("library-source-folder-pick"))
    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith({ kind: "folder", folderPath: "/papers/neuro" })
    })
  })

  test("a cancelled folder picker does not connect", async () => {
    const onConnect = vi.fn()
    renderChooser(onConnect, { "system.pickDirectory": () => null })
    fireEvent.click(screen.getByTestId("library-source-folder-pick"))
    // Give the mutation a tick to settle, then assert nothing connected.
    await waitFor(() => {
      expect(screen.getByTestId("library-source-folder-pick")).toBeTruthy()
    })
    expect(onConnect).not.toHaveBeenCalled()
  })

  test("the Zotero advanced toggle reveals the connect form", () => {
    renderChooser(vi.fn())
    expect(screen.queryByTestId("zotero-connect")).toBeNull()
    fireEvent.click(screen.getByTestId("zotero-local-advanced-toggle"))
    expect(screen.getByTestId("zotero-connect")).toBeTruthy()
  })
})
