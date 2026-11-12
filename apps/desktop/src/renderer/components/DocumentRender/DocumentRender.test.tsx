import { QueryClient } from "@tanstack/react-query"
import { describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../test/fakeTrpcClient"
import { fireEvent, render, screen, waitFor } from "../../test/render"
import { RenderControl, RenderedDocument } from "./DocumentRender"

/** Component test for the Render and Install buttons, with a faked tRPC client (mocked main process). */

const IDLE = { state: "idle", progress: null, message: "", error: null }
const QUARTO = { path: "/tools/quarto", version: "1.11.9", error: null }

function tools(quarto: unknown, installation: unknown) {
  return () => ({ quarto, myst: null, installation: { quarto: installation, myst: IDLE } })
}

function show(handlers: FakeHandlers, node: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AppProviders client={createFakeTrpcClient(handlers)} queryClient={queryClient}>
      {node}
    </AppProviders>,
  )
}

describe("RenderControl", () => {
  test("Render runs the render and passes the result on", async () => {
    const result = { tool: "quarto", ok: true, log: "done", outputRelPath: "_render/a.qmd/a.html" }
    const renderCall = vi.fn(() => result)
    const onRendered = vi.fn()
    show(
      { "documents.tools": tools(QUARTO, IDLE), "documents.render": renderCall },
      <RenderControl projectId="p1" relPath="a.qmd" tool="quarto" onRendered={onRendered} />,
    )

    fireEvent.click(await screen.findByRole("button", { name: "Render" }))

    await waitFor(() => expect(onRendered).toHaveBeenCalledWith(result))
    expect(renderCall).toHaveBeenCalledWith({ projectId: "p1", relPath: "a.qmd" })
  })

  test("passes a failed render call on as a failed result with its message", async () => {
    const onRendered = vi.fn()
    show(
      {
        "documents.tools": tools(QUARTO, IDLE),
        "documents.render": () => Promise.reject(new Error("Quarto was not found.")),
      },
      <RenderControl projectId="p1" relPath="a.qmd" tool="quarto" onRendered={onRendered} />,
    )
    fireEvent.click(await screen.findByRole("button", { name: "Render" }))
    await waitFor(() =>
      expect(onRendered).toHaveBeenCalledWith({
        tool: "quarto",
        ok: false,
        log: "Quarto was not found.",
        outputRelPath: null,
      }),
    )
  })

  test("shows Install when the tool is missing, and its progress while installing", async () => {
    let installation: unknown = IDLE
    const install = vi.fn(() => {
      installation = {
        state: "downloading",
        progress: 40,
        message: "Quarto: Downloading…",
        error: null,
      }
      return { started: true }
    })
    show(
      { "documents.tools": () => tools(null, installation)(), "documents.install": install },
      <RenderControl projectId="p1" relPath="a.qmd" tool="quarto" onRendered={() => {}} />,
    )
    expect(screen.queryByRole("button", { name: "Render" })).toBeNull()

    fireEvent.click(await screen.findByRole("button", { name: "Install Quarto" }))

    await waitFor(() => expect(install).toHaveBeenCalledWith({ tool: "quarto" }))
    expect(await screen.findByText("Quarto: Downloading…")).toBeTruthy()
    expect(screen.getByRole("progressbar", { name: "Quarto installation" })).toBeTruthy()
  })

  test("shows an install error", async () => {
    show(
      {
        "documents.tools": tools(null, {
          state: "failed",
          progress: null,
          message: "Quarto installation failed.",
          error: "Quarto archive verification failed",
        }),
      },
      <RenderControl projectId="p1" relPath="a.qmd" tool="quarto" onRendered={() => {}} />,
    )
    expect(await screen.findByRole("button", { name: "Install Quarto" })).toBeTruthy()
    expect((await screen.findByRole("alert")).textContent).toContain("verification failed")
  })
})

describe("RenderedDocument", () => {
  test("shows the page and Open in browser after a render that worked", async () => {
    const open = vi.fn(() => undefined)
    show(
      { "documents.openInBrowser": open },
      <RenderedDocument
        projectId="p1"
        result={{
          tool: "quarto",
          ok: true,
          log: "Output created",
          outputRelPath: "_render/a.html",
        }}
        onClose={() => {}}
      >
        <p>page</p>
      </RenderedDocument>,
    )
    expect(screen.getByText("page")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }))
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith({ projectId: "p1", relPath: "_render/a.html" }),
    )
  })

  test("shows the build log and no page after a failed render", () => {
    show(
      {},
      <RenderedDocument
        projectId="p1"
        result={{ tool: "quarto", ok: false, log: "ERROR: bad chunk", outputRelPath: null }}
        onClose={() => {}}
      >
        <p>page</p>
      </RenderedDocument>,
    )
    expect(screen.queryByText("page")).toBeNull()
    expect(screen.getByRole("alert").textContent).toContain("Render failed")
    expect(screen.getByTestId("document-render-log").textContent).toContain("ERROR: bad chunk")
    expect(screen.queryByRole("button", { name: "Open in browser" })).toBeNull()
  })
})
