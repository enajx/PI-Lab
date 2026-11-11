import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { QueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../test/fakeTrpcClient"
import { fireEvent, render, screen, waitFor, within } from "../../test/render"

/**
 * Component test for the research diary panel, with a faked tRPC client (mocked
 * main process). The real CodeMirror view needs layout APIs jsdom lacks, so it is
 * stubbed with a buffer that shows its seeded doc and can append " EDIT".
 */

vi.mock("../../Editor/components/CodeMirrorBuffer", () => ({
  CodeMirrorBuffer: ({
    initialDoc,
    onChange,
  }: {
    initialDoc: string
    onChange: (doc: string) => void
  }) => {
    const [seeded] = useState(initialDoc)
    return (
      <div data-testid="editor-buffer">
        <pre data-testid="buffer-doc">{seeded}</pre>
        <button type="button" data-testid="buffer-type" onClick={() => onChange(`${seeded} EDIT`)}>
          type
        </button>
      </div>
    )
  },
}))

const { ResearchDiaryPanel } = await import("./ResearchDiaryPanel")

const LOADED = {
  relPath: "md/research-diary/diary.md",
  content: "## 2026-11-11\n\nRan the baseline.\n",
  baseline: { exists: true, mtimeMs: 10, size: 33 },
}

function renderPanel(save: FakeHandlers[string], loaded: typeof LOADED, extra: FakeHandlers) {
  const handlers: FakeHandlers = {
    "settings.get": () => ({ editor: DEFAULT_EDITOR_SETTINGS }),
    "diary.open": () => loaded,
    "diary.save": save,
    ...extra,
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AppProviders client={createFakeTrpcClient(handlers)} queryClient={queryClient}>
      <ResearchDiaryPanel projectId="p1" />
    </AppProviders>,
  )
}

describe("ResearchDiaryPanel", () => {
  test("shows the rendered diary, edits the source, and saves back to the rendered view", async () => {
    const saves: unknown[] = []
    renderPanel(
      (input) => {
        saves.push(input)
        return { baseline: { exists: true, mtimeMs: 20, size: 38 } }
      },
      LOADED,
      {},
    )
    const panel = await screen.findByTestId("research-diary-panel")
    expect(await within(panel).findByRole("heading", { name: "2026-11-11" })).toBeTruthy()

    fireEvent.click(within(panel).getByRole("button", { name: "Edit" }))
    expect(screen.getByTestId("buffer-doc").textContent).toBe(LOADED.content)
    fireEvent.click(screen.getByTestId("buffer-type"))
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }))

    await waitFor(() => expect(screen.queryByTestId("editor-buffer")).toBeNull())
    expect(saves).toEqual([
      {
        projectId: "p1",
        relPath: LOADED.relPath,
        content: `${LOADED.content} EDIT`,
        baseline: LOADED.baseline,
      },
    ])
    expect(within(panel).getByText(/Ran the baseline\. EDIT/)).toBeTruthy()
  })

  test("shows the error and keeps the edit open when the file changed on disk", async () => {
    renderPanel(
      () =>
        Promise.reject(
          new Error("md/research-diary/diary.md changed on disk since it was loaded."),
        ),
      LOADED,
      {},
    )
    const panel = await screen.findByTestId("research-diary-panel")
    await within(panel).findByRole("heading", { name: "2026-11-11" })

    fireEvent.click(within(panel).getByRole("button", { name: "Edit" }))
    fireEvent.click(screen.getByTestId("buffer-type"))
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }))

    expect((await within(panel).findByRole("alert")).textContent).toMatch(/changed on disk/)
    expect(screen.getByTestId("editor-buffer")).toBeTruthy()
  })

  test("hides a MyST or Quarto front matter in the rendered view and keeps it in the source", async () => {
    const content = "---\ntitle: Research diary\n---\n\n## 2026-11-11\n\nRan the baseline.\n"
    renderPanel(() => null, { ...LOADED, content }, {})
    const panel = await screen.findByTestId("research-diary-panel")
    expect(await within(panel).findByRole("heading", { name: "2026-11-11" })).toBeTruthy()
    expect(within(panel).queryByText(/title: Research diary/)).toBeNull()

    fireEvent.click(within(panel).getByRole("button", { name: "Edit" }))
    expect(screen.getByTestId("buffer-doc").textContent).toBe(content)
  })

  test("renders a Quarto diary with Render and shows the page in the panel", async () => {
    const renders: unknown[] = []
    renderPanel(
      () => null,
      { ...LOADED, relPath: "md/research-diary/diary.qmd" },
      {
        "documents.tools": () => ({
          quarto: { path: "/tools/quarto", version: "1.11.9", error: null },
          myst: null,
          installation: {
            quarto: { state: "idle", progress: null, message: "", error: null },
            myst: { state: "idle", progress: null, message: "", error: null },
          },
        }),
        "documents.render": (input) => {
          renders.push(input)
          return {
            tool: "quarto",
            ok: true,
            log: "Output created",
            outputRelPath: "md/research-diary/_render/diary.qmd/diary.html",
          }
        },
        "science.analysis.openInteractive": () => ({
          type: "html",
          url: "pi-lab-report://token/diary.html",
        }),
        "science.analysis.closeInteractive": () => undefined,
      },
    )
    const panel = await screen.findByTestId("research-diary-panel")
    await within(panel).findByRole("heading", { name: "2026-11-11" })

    fireEvent.click(await within(panel).findByRole("button", { name: "Render" }))

    const page = await within(panel).findByTestId("analysis-preview-html")
    expect(page.getAttribute("src")).toBe("pi-lab-report://token/diary.html")
    expect(renders).toEqual([{ projectId: "p1", relPath: "md/research-diary/diary.qmd" }])
    fireEvent.click(within(panel).getByRole("button", { name: "Show source" }))
    expect(await within(panel).findByRole("heading", { name: "2026-11-11" })).toBeTruthy()
  })

  test("shows no Render button for a plain Markdown diary", async () => {
    renderPanel(() => null, LOADED, {})
    const panel = await screen.findByTestId("research-diary-panel")
    await within(panel).findByRole("heading", { name: "2026-11-11" })
    expect(within(panel).queryByRole("button", { name: "Render" })).toBeNull()
  })
})
