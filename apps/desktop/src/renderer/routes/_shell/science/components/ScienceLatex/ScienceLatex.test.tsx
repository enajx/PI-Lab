import { focusManager, QueryClient } from "@tanstack/react-query"
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

/** {@link renderPage} with extra fake procedures (they replace the default ones). */
function renderPageWith(paperGet: FakeHandlers[string], extra: FakeHandlers) {
  const client = createFakeTrpcClient({
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
    // Last, so a test can replace any of the procedures above.
    ...extra,
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <ScienceLatex initialProjectId="p1" focusSession={null} />
    </AppProviders>,
  )
}

test("with a paper linked, the Sync button is in the page top bar and the other Sync items are in the editor footer", async () => {
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
  expect(within(header).queryByTestId("paper-last-sync")).toBeNull()
  expect(screen.queryByTestId("paper-sync-bar")).toBeNull()
  const footer = screen.getByTestId("editor-status-bar")
  expect(within(footer).getByTestId("paper-last-sync").textContent).toBe("Not synced yet")
  expect(within(footer).getByTestId("paper-output-folder").textContent).toBe("Output: build")
  // Order after the file name: last sync, output folder, paper folder.
  const ids = Array.from(footer.querySelectorAll("[data-testid]"), (node) =>
    node.getAttribute("data-testid"),
  ).filter(
    (id) =>
      id === "paper-last-sync" || id === "paper-output-folder" || id === "editor-paper-folder",
  )
  expect(ids).toEqual(["paper-last-sync", "paper-output-folder", "editor-paper-folder"])
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
  let current: unknown = { paper: null, workspaceId: null, rootRelPath: null, autoDetect: true }
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

test("the footer shows the paper folder; Clear paper folder shows the setup page without setting a folder again", async () => {
  const linked = {
    paper: {
      dir: "/proj/paper",
      displayDir: "paper",
      lastSyncAt: null,
      remoteUrl: "https://git.overleaf.com/abc",
      isOverleaf: true,
      outputDir: null,
      effectiveOutputDir: "build",
      syncEnabled: true,
    },
    workspaceId: "paper-ws",
    rootRelPath: "main.tex",
    autoDetect: true,
  }
  // First visit: no folder yet, and auto-detection finds one clone and uses it.
  let current: unknown = { paper: null, workspaceId: null, rootRelPath: null, autoDetect: true }
  const unlink = vi.fn(() => {
    current = { paper: null, workspaceId: null, rootRelPath: null, autoDetect: false }
    return { ok: true }
  })
  const detect = vi.fn(() => ({
    clones: [{ dir: "/proj/paper", relPath: "paper" }],
    stoppedEarly: false,
  }))
  const link = vi.fn(() => {
    current = linked
    return linked
  })
  renderPageWith(() => current, {
    "paper.unlink": unlink,
    "paper.detect": detect,
    "paper.link": link,
  })
  const bar = await screen.findByTestId("editor-status-bar")
  const item = await within(bar).findByTestId("editor-paper-folder")
  expect(item.textContent).toBe("paper")
  expect(link).toHaveBeenCalledTimes(1)
  fireEvent.click(item)
  fireEvent.click(screen.getByTestId("paper-folder-clear"))
  expect(await screen.findByTestId("paper-setup-overleaf")).toBeTruthy()
  expect(screen.getByTestId("paper-setup-folder")).toBeTruthy()
  expect(unlink).toHaveBeenCalledWith({ projectId: "p1" })
  // The earlier search result is not used again.
  await new Promise((done) => setTimeout(done, 200))
  expect(screen.queryByTestId("paper-editor")).toBeNull()
  expect(screen.queryByTestId("paper-detecting")).toBeNull()
  expect(link).toHaveBeenCalledTimes(1)
  expect(detect).toHaveBeenCalledTimes(1)
})

test("Create paper keeps the setup shown while the PDF builds, then opens main.tex with the built PDF beside it", async () => {
  const created = {
    paper: {
      dir: "/proj/paper",
      displayDir: "paper",
      lastSyncAt: null,
      remoteUrl: null,
      isOverleaf: false,
      outputDir: null,
      effectiveOutputDir: "build",
      syncEnabled: true,
    },
    workspaceId: "paper-ws",
    rootRelPath: "main.tex",
    autoDetect: true,
  }
  let current: unknown = { paper: null, workspaceId: null, rootRelPath: null, autoDetect: true }
  const builds: unknown[] = []
  let finishBuild: (result: unknown) => void = () => undefined
  let paperGets = 0
  const paperGet = (): unknown => {
    paperGets += 1
    return current
  }
  renderPageWith(paperGet, {
    "paper.detect": () => ({ clones: [], stoppedEarly: false }),
    "paper.createTarget": () => ({ dir: "/proj/paper", displayDir: "paper", available: true }),
    "paper.create": () => {
      current = created
      return created
    },
    "pdf.build": (input) => {
      builds.push(input)
      return new Promise((resolve) => {
        finishBuild = resolve
      })
    },
    "files.stat": (input) => {
      const relPath = (input as { relPath: string }).relPath
      if (relPath === "main.tex") return { exists: true, mtimeMs: 1, size: 10 }
      return relPath === "build/main.pdf" && builds.length > 0
        ? { exists: true, mtimeMs: 2, size: 10 }
        : { exists: false, mtimeMs: 0, size: 0 }
    },
  })
  const button = (await screen.findByTestId("paper-create")) as HTMLButtonElement
  await waitFor(() => expect(button.disabled).toBe(false))
  fireEvent.click(button)
  await waitFor(() => expect(button.textContent).toBe("Building PDF…"))
  // The paper state is read again while the PDF builds (the window got the focus back),
  // and it already has the new paper: the setup still stays until the build ends.
  const getsBefore = paperGets
  focusManager.setFocused(false)
  focusManager.setFocused(true)
  await waitFor(() => expect(paperGets).toBeGreaterThan(getsBefore))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(screen.queryByTestId("paper-editor")).toBeNull()
  finishBuild({ relPath: "build/main.pdf", success: true, log: "" })
  expect(await screen.findByTestId("paper-editor")).toBeTruthy()
  await waitFor(() =>
    expect(
      screen
        .getAllByTestId("central-tab")
        .map((tab) => within(tab).getByTestId("central-tab-select").getAttribute("aria-label")),
    ).toEqual(["main.tex", "main.pdf"]),
  )
  expect(builds).toEqual([{ workspaceId: "paper-ws", relPath: "main.tex" }])
})
