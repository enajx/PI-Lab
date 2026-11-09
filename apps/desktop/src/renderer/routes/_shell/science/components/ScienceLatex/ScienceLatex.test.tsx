import { QueryClient } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import type { FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { createFakeTrpcClient } from "../../../../../test/fakeTrpcClient"

/**
 * Component test for the LaTeX Editor project picker. The tRPC server and the
 * router are fakes (mocked); the e2e test covers the real app.
 */
const mocks = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }))
// xterm and CodeMirror need layout APIs jsdom lacks.
vi.mock("../../../../../Terminal", () => ({ Terminal: () => <div data-testid="terminal" /> }))
vi.mock("../../../../../Editor/components/CodeMirrorBuffer", () => ({
  CodeMirrorBuffer: ({ relPath }: { relPath: string }) => (
    <div data-testid="editor-buffer">{relPath}</div>
  ),
}))

const { ScienceLatex } = await import("./ScienceLatex")

beforeEach(() => {
  window.localStorage.clear()
  mocks.navigate.mockReset()
})
afterEach(() => cleanup())

test("after arriving with a project in the address, the picker still switches project and is remembered", async () => {
  const client = createFakeTrpcClient({
    "projects.list": () => [
      { id: "p1", name: "One" },
      { id: "p2", name: "Two" },
    ],
    "settings.get": () => ({}),
    "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    "paper.detect": () => ({ clones: [], stoppedEarly: false }),
    "paper.token.status": () => ({ configured: true, source: "saved" }),
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <ScienceLatex
        initialProjectId="p1"
        focusSession={{ sessionId: "s1", agentId: "codex", agentLabel: "Codex" }}
      />
    </AppProviders>,
  )
  const select = (await screen.findByTestId("latex-project-select")) as HTMLSelectElement
  await waitFor(() => expect(select.value).toBe("p1"))
  fireEvent.change(select, { target: { value: "p2" } })
  // The address switches to the chosen project and drops the agent to focus.
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/science/latex",
    search: { projectId: "p2" },
    replace: true,
  })
  expect(window.localStorage.getItem("pi-lab.latexEditor.project")).toContain("p2")
})

/** Mount the page for project p1 with the given `paper.get` answer. */
function renderPage(paperGet: FakeHandlers[string]) {
  return renderPageWith(paperGet, { "paper.detect": () => [] })
}

/** {@link renderPage} with extra fake procedures. */
function renderPageWith(paperGet: FakeHandlers[string], extra: FakeHandlers) {
  const client = createFakeTrpcClient({
    ...extra,
    "projects.list": () => [{ id: "p1", name: "One" }],
    "settings.get": () => ({}),
    "paper.get": paperGet,
    "paper.token.status": () => ({ configured: true, source: "saved" }),
    "paper.outline": () => [],
    "files.tree": () => [],
    "files.stat": () => ({ exists: false, mtimeMs: 0, size: 0 }),
    "files.read": () => ({
      status: "text",
      exists: true,
      content: "",
      baseline: { exists: true, mtimeMs: 1, size: 0 },
    }),
    "agents.list": () => [],
    "agents.projectChoice": () => ({ agentId: null, storage: "app" }),
    "terminal.list": () => [],
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <ScienceLatex initialProjectId="p1" focusSession={null} />
    </AppProviders>,
  )
}

test("with a paper linked, the Sync button is in the page top bar next to the project picker", async () => {
  const { container } = renderPage(() => ({
    paper: {
      lastSyncAt: null,
      remoteUrl: "https://git.overleaf.com/abc",
      outputDir: null,
      effectiveOutputDir: "build",
      syncEnabled: true,
    },
    workspaceId: "paper-ws",
    rootRelPath: "main.tex",
  }))
  const header = container.querySelector("header") as HTMLElement
  expect(await within(header).findByTestId("paper-sync")).toBeTruthy()
  expect(within(header).getByTestId("latex-project-select")).toBeTruthy()
  expect(within(screen.getByTestId("paper-sync-bar")).queryByTestId("paper-sync")).toBeNull()
})

test("without a paper there is no Sync button", async () => {
  renderPage(() => ({ paper: null, workspaceId: null, rootRelPath: null }))
  await screen.findByTestId("paper-setup")
  expect(screen.queryByTestId("paper-sync")).toBeNull()
})

test("opening a project with one Overleaf clone links it and shows the editor, not the setup", async () => {
  const linked = {
    paper: {
      dir: "/proj/paper",
      lastSyncAt: null,
      remoteUrl: "https://git.overleaf.com/abc",
      isOverleaf: true,
      outputDir: null,
      effectiveOutputDir: "build",
      syncEnabled: true,
    },
    workspaceId: "paper-ws",
    rootRelPath: "main.tex",
  }
  let current: unknown = { paper: null, workspaceId: null, rootRelPath: null }
  const link = vi.fn(() => {
    current = linked
    return linked
  })
  renderPageWith(() => current, {
    "paper.detect": () => ({
      clones: [{ dir: "/proj/paper", relPath: "paper" }],
      stoppedEarly: false,
    }),
    "paper.link": link,
  })
  expect(await screen.findByTestId("paper-editor")).toBeTruthy()
  expect(link).toHaveBeenCalledWith({ projectId: "p1", dir: "/proj/paper", rootChoice: null })
  expect(screen.queryByTestId("paper-setup-overleaf")).toBeNull()
})
