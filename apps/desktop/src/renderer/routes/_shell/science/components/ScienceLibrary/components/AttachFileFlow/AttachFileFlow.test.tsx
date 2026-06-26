import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { AppProviders } from "../../../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../../../test/fakeTrpcClient"
import { AttachFileFlow } from "./AttachFileFlow"

/**
 * Component test for the per-item attach flow (docs/testing-and-build.md). jsdom + a fake tRPC
 * client: clicking "Attach" picks a file (`system.pickFile`) then calls
 * `science.library.attachFile`, and the typed result drives an inline success/error.
 */
function renderFlow(handlers: FakeHandlers) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const client = createFakeTrpcClient(handlers)
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <AttachFileFlow itemKey="DOC1" />
    </AppProviders>,
  )
}

describe("AttachFileFlow", () => {
  test("attaches the picked file and shows success", async () => {
    renderFlow({
      "system.pickFile": () => "/tmp/note.md",
      "science.library.attachFile": (input) => {
        expect(input).toMatchObject({ itemKey: "DOC1", filePath: "/tmp/note.md" })
        return { ok: true, attachmentKey: "ATT1" }
      },
    })
    fireEvent.click(screen.getByTestId("library-item-attach"))
    await waitFor(() => {
      expect(screen.getByTestId("library-item-attach-done")).toBeTruthy()
    })
  })

  test("surfaces a writes-disabled error", async () => {
    renderFlow({
      "system.pickFile": () => "/tmp/note.md",
      "science.library.attachFile": () => ({
        ok: false,
        reason: "writes-disabled",
        message: "Set the Zotero debug-bridge token in Settings.",
      }),
    })
    fireEvent.click(screen.getByTestId("library-item-attach"))
    await waitFor(() => {
      expect(screen.getByTestId("library-item-attach-error").textContent).toContain("bridge token")
    })
  })

  test("no-ops when the file picker is cancelled", async () => {
    let attachCalled = false
    renderFlow({
      "system.pickFile": () => null,
      "science.library.attachFile": () => {
        attachCalled = true
        return { ok: true, attachmentKey: "X" }
      },
    })
    fireEvent.click(screen.getByTestId("library-item-attach"))
    await waitFor(() => {
      expect(screen.queryByTestId("library-item-attach-done")).toBeNull()
    })
    expect(attachCalled).toBe(false)
  })
})
