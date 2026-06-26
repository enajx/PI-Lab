import { QueryClient } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { AppProviders } from "../../../../../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../../../../../test/fakeTrpcClient"
import { ResearchPanel } from "./ResearchPanel"

/**
 * Component test for the Research panel (docs/testing-and-build.md): mount it under the real
 * providers with a *faked* tRPC client (a real client over an in-memory link, so
 * no IPC/main process is needed). We assert the two behaviours that matter —
 * rendering a present RESEARCH.md as markdown, and the empty state when the file
 * is absent.
 *
 * jsdom (not Browser Mode) is sufficient here: ResearchPanel renders plain text
 * nodes (no Radix/layout/pointer behaviour), so a light DOM is enough.
 */

function renderPanel(read: (input: unknown) => { exists: boolean; content: string }) {
  // Retries off so an unexpected handler error surfaces immediately rather than
  // hanging the test behind backoff.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({ "files.read": read })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <ResearchPanel workspaceId="ws-1" />
    </AppProviders>,
  )
}

describe("ResearchPanel", () => {
  test("renders RESEARCH.md content as markdown", async () => {
    renderPanel(() => ({
      exists: true,
      content: "# Findings\n\nThe effect was **significant**.",
    }))

    await waitFor(() => {
      expect(screen.getByText("Findings")).toBeTruthy()
    })
    // The heading is rendered as an <h1> by the markdown renderer.
    expect(screen.getByText("Findings").tagName).toBe("H1")
    // Bold text becomes a <strong>.
    expect(screen.getByText("significant").tagName).toBe("STRONG")
    expect(screen.queryByTestId("panel-research-empty")).toBeNull()
  })

  test("shows the empty state when RESEARCH.md is absent", async () => {
    renderPanel(() => ({ exists: false, content: "" }))

    await waitFor(() => {
      expect(screen.getByTestId("panel-research-empty")).toBeTruthy()
    })
    expect(screen.getByText("No RESEARCH.md yet")).toBeTruthy()
    expect(screen.queryByTestId("markdown")).toBeNull()
  })

  test("shows the empty state when RESEARCH.md exists but is blank", async () => {
    renderPanel(() => ({ exists: true, content: "   \n" }))

    await waitFor(() => {
      expect(screen.getByTestId("panel-research-empty")).toBeTruthy()
    })
  })

  test("passes the workspace id and RESEARCH.md path to files.read", async () => {
    let received: unknown
    renderPanel((input) => {
      received = input
      return { exists: false, content: "" }
    })

    await waitFor(() => {
      expect(received).toEqual({ workspaceId: "ws-1", relPath: "RESEARCH.md" })
    })
  })
})
