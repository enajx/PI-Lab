import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { PaperSetup } from "./PaperSetup"

/**
 * Component tests for adding a paper in the LaTeX Editor with no project. The
 * tRPC server is a fake (mocked); the real paper-only project is covered by
 * the `paper` router tests (standalone.test.ts) and the e2e test.
 */
let added: string[] = []

function renderStandalone(handlers: FakeHandlers) {
  added = []
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({
    "paper.token.status": () => ({ configured: true, source: "saved" }),
    "system.homeDir": () => "/Users/me",
    "paper.standaloneTarget": (input) => ({
      dir:
        (input as { url: string | null }).url === null
          ? "/Users/me/Papers/paper"
          : "/Users/me/Papers/abc123",
    }),
    "settings.get": () => ({ editor: DEFAULT_EDITOR_SETTINGS }),
    ...handlers,
  })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <PaperSetup
        projectId={null}
        autoDetect={false}
        onCreateStart={() => undefined}
        onCreated={() => undefined}
        onAdded={(projectId) => added.push(projectId)}
      />
    </AppProviders>,
  )
}

describe("PaperSetup with no project (mocked server)", () => {
  test("Use an existing folder adds the chosen folder as a paper and opens it", async () => {
    const addStandalone = vi.fn(() => ({ projectId: "new" }))
    renderStandalone({
      "system.pickDirectory": () => "/Users/me/my-paper",
      "paper.addStandalone": addStandalone,
    })
    fireEvent.click(await screen.findByTestId("paper-use-folder"))
    await waitFor(() =>
      expect(addStandalone).toHaveBeenCalledWith({ source: "folder", dir: "/Users/me/my-paper" }),
    )
    await waitFor(() => expect(added).toEqual(["new"]))
  })

  test("Start draft asks where to put the paper, proposing ~/Papers/paper, and can remember the folder", async () => {
    const addStandalone = vi.fn(() => ({ projectId: "draft" }))
    const updateEditor = vi.fn(() => DEFAULT_EDITOR_SETTINGS)
    renderStandalone({
      "paper.addStandalone": addStandalone,
      "paper.get": () => ({ paper: null, workspaceId: "w1", rootRelPath: "main.tex" }),
      "pdf.build": () => ({ ok: true }),
      "settings.updateEditor": updateEditor,
    })
    await waitFor(() =>
      expect(screen.getByTestId("paper-create-folder").textContent).toBe("~/Papers/paper/"),
    )
    fireEvent.click(screen.getByTestId("paper-create"))
    const field = (await screen.findByTestId("paper-destination-dir")) as HTMLInputElement
    expect(field.value).toBe("~/Papers/paper")
    fireEvent.change(field, { target: { value: "~/Papers/thesis" } })
    fireEvent.click(screen.getByTestId("paper-destination-remember"))
    fireEvent.click(screen.getByTestId("paper-destination-ok"))
    await waitFor(() =>
      expect(addStandalone).toHaveBeenCalledWith({ source: "draft", dir: "~/Papers/thesis" }),
    )
    expect(updateEditor).toHaveBeenCalledWith({ papersFolder: "~/Papers", askPapersFolder: false })
    await waitFor(() => expect(added).toEqual(["draft"]))
  })

  test("Cancel in the folder question adds nothing", async () => {
    const addStandalone = vi.fn(() => ({ projectId: "draft" }))
    renderStandalone({ "paper.addStandalone": addStandalone })
    fireEvent.click(await screen.findByTestId("paper-create"))
    fireEvent.click(await screen.findByTestId("paper-destination-cancel"))
    await waitFor(() => expect(screen.queryByTestId("paper-destination-dir")).toBeNull())
    expect(addStandalone).not.toHaveBeenCalled()
  })

  test("with the folder remembered, Add Overleaf project clones straight into <papers folder>/<Overleaf id>", async () => {
    const addStandalone = vi.fn(() => ({ projectId: "ol" }))
    renderStandalone({
      "settings.get": () => ({ editor: { ...DEFAULT_EDITOR_SETTINGS, askPapersFolder: false } }),
      "paper.addStandalone": addStandalone,
    })
    fireEvent.change(await screen.findByTestId("paper-overleaf-url"), {
      target: { value: "https://git@git.overleaf.com/abc123" },
    })
    await waitFor(() =>
      expect((screen.getByTestId("paper-overleaf-add") as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId("paper-overleaf-add"))
    await waitFor(() =>
      expect(addStandalone).toHaveBeenCalledWith({
        source: "overleaf",
        url: "https://git@git.overleaf.com/abc123",
        dir: "/Users/me/Papers/abc123",
      }),
    )
    expect(screen.queryByTestId("paper-destination-dir")).toBeNull()
    await waitFor(() => expect(added).toEqual(["ol"]))
  })
})
