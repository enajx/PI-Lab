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
        newPaper={false}
        focusSession={{ sessionId: "s1", agentId: "codex", agentLabel: "Codex" }}
      />
    </AppProviders>,
  )
  const select = (await screen.findByTestId("latex-project-select")) as HTMLButtonElement
  await waitFor(() => expect(select.value).toBe("p1"))
  fireEvent.click(select)
  fireEvent.click(screen.getByRole("option", { name: "Two" }))
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
      <ScienceLatex initialProjectId="p1" newPaper={false} focusSession={null} />
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

test("Start draft keeps the setup shown while the PDF builds, then opens main.tex with the built PDF beside it", async () => {
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
    "paper.createTarget": () => ({ dir: "/proj/paper", displayDir: "paper" }),
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

test("a moved paper folder shows a clear message with Choose paper folder… and Clear paper folder", async () => {
  const unlink = vi.fn(() => ({ ok: true }))
  const pickDirectory = vi.fn(() => null)
  renderPageWith(
    () => ({
      paper: {
        dir: "/Users/me/old-paper",
        displayDir: "~/old-paper",
        lastSyncAt: null,
        remoteUrl: null,
        outputDir: null,
        effectiveOutputDir: "build",
        syncEnabled: true,
        missing: true,
      },
      workspaceId: "paper-ws",
      rootRelPath: null,
      autoDetect: true,
      skippedFolders: [],
    }),
    {
      "paper.detect": () => [],
      "paper.unlink": unlink,
      "system.pickDirectory": pickDirectory,
    },
  )
  const missing = await screen.findByTestId("paper-folder-missing")
  expect(missing.textContent).toContain(
    "The paper folder /Users/me/old-paper was moved or deleted.",
  )
  expect(screen.queryByTestId("editor-status-bar")).toBeNull()
  fireEvent.click(within(missing).getByRole("button", { name: "Choose paper folder…" }))
  await waitFor(() => expect(pickDirectory).toHaveBeenCalled())
  fireEvent.click(within(missing).getByRole("button", { name: "Clear paper folder" }))
  await waitFor(() => expect(unlink).toHaveBeenCalledWith({ projectId: "p1" }))
})

test("subfolders that could not be read are listed as skipped", async () => {
  renderPage(() => ({
    paper: {
      dir: "/p/paper",
      displayDir: "paper",
      lastSyncAt: null,
      remoteUrl: null,
      outputDir: null,
      effectiveOutputDir: "build",
      syncEnabled: true,
      missing: false,
    },
    workspaceId: "paper-ws",
    rootRelPath: "main.tex",
    autoDetect: true,
    skippedFolders: ["locked", "private/data"],
  }))
  expect((await screen.findByTestId("paper-skipped-folders")).textContent).toBe(
    "Skipped folders that could not be read: locked, private/data",
  )
})

/** Mount the page with these projects and no paper linked anywhere. */
function renderWithProjects(projects: unknown[], extra: FakeHandlers) {
  return renderWithProjectsNew(projects, extra, false)
}

/** {@link renderWithProjects} with New paper… chosen (`newPaper` in the address) or not. */
function renderWithProjectsNew(projects: unknown[], extra: FakeHandlers, newPaper: boolean) {
  const client = createFakeTrpcClient({
    "projects.list": () => projects,
    "settings.get": () => ({}),
    "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null, autoDetect: false }),
    "paper.detect": () => ({ clones: [], stoppedEarly: false }),
    "paper.createTarget": () => ({ dir: "/p/paper", displayDir: "paper" }),
    "paper.standaloneTarget": () => ({ dir: "/Users/me/Papers/paper" }),
    "paper.token.status": () => ({ configured: true, source: "saved" }),
    ...extra,
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <ScienceLatex newPaper={newPaper} focusSession={null} />
    </AppProviders>,
  )
}

test("with no projects, the page shows the paper cards to add a paper with no project", async () => {
  const addStandalone = vi.fn(() => ({ projectId: "new" }))
  renderWithProjects([], {
    "system.pickDirectory": () => "/Users/me/my-paper",
    "paper.addStandalone": addStandalone,
  })
  fireEvent.click(await screen.findByTestId("paper-use-folder"))
  await waitFor(() =>
    expect(addStandalone).toHaveBeenCalledWith({ source: "folder", dir: "/Users/me/my-paper" }),
  )
  // The new paper-only project is chosen.
  await waitFor(() =>
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/science/latex",
      search: { projectId: "new" },
      replace: true,
    }),
  )
  expect(screen.queryByText("No open projects")).toBeNull()
})

test("New paper… in the picker puts newPaper in the address, so opening a project later clears it", async () => {
  renderWithProjects([{ id: "p1", name: "One" }], {})
  fireEvent.click(await screen.findByTestId("latex-project-select"))
  fireEvent.click(screen.getByRole("option", { name: "New paper…" }))
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/science/latex",
    search: { newPaper: true },
    replace: true,
  })
})

test("with newPaper in the address, the page shows the cards for a paper with no project", async () => {
  const addStandalone = vi.fn(() => ({ projectId: "new" }))
  renderWithProjectsNew(
    [{ id: "p1", name: "One" }],
    {
      "system.pickDirectory": () => "/Users/me/my-paper",
      "paper.addStandalone": addStandalone,
    },
    true,
  )
  await screen.findByTestId("paper-setup-overleaf")
  expect((screen.getByTestId("latex-project-select") as HTMLButtonElement).value).toBe(
    "__new-paper__",
  )
  fireEvent.click(screen.getByTestId("paper-use-folder"))
  await waitFor(() =>
    expect(addStandalone).toHaveBeenCalledWith({ source: "folder", dir: "/Users/me/my-paper" }),
  )
})

test("a paper-only project can be linked to a project without a paper", async () => {
  const moveToProject = vi.fn(() => ({ paper: null, workspaceId: null, rootRelPath: null }))
  renderWithProjects(
    [
      { id: "solo", name: "My paper", metadata: { paperOnly: true } },
      { id: "p1", name: "One", metadata: null },
      { id: "p2", name: "Has paper", metadata: { paper: { dir: "/x" } } },
    ],
    { "paper.moveToProject": moveToProject },
  )
  const button = await screen.findByTestId("latex-link-to-project")
  expect(button.textContent).toBe("Link to project")
  fireEvent.click(button)
  expect(screen.queryByRole("menuitem", { name: "Has paper" })).toBeNull()
  fireEvent.click(screen.getByRole("menuitem", { name: "One" }))
  await waitFor(() =>
    expect(moveToProject).toHaveBeenCalledWith({ fromProjectId: "solo", toProjectId: "p1" }),
  )
  await waitFor(() =>
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/science/latex",
      search: { projectId: "p1" },
      replace: true,
    }),
  )
})

test("a normal project has no Link to project button", async () => {
  renderWithProjects([{ id: "p1", name: "One", metadata: null }], {})
  await screen.findByTestId("paper-setup")
  expect(screen.queryByTestId("latex-link-to-project")).toBeNull()
})
