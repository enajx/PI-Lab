import type { Project } from "@pi-lab/local-db"
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { setInterfaceLanguage } from "../../../../../i18n/language"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import type { FocusSessionRequest } from "../ScienceSessionPanel"

// The router is a fake (mocked): the picker's address change is asserted as a call.
const mocks = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }))

// xterm needs layout APIs jsdom lacks, so the terminal is a stub that shows its session id.
vi.mock("../../../../../Terminal", () => ({
  Terminal: ({ inputKind, sessionId }: { inputKind: "agent" | "terminal"; sessionId?: string }) => (
    <div data-testid="terminal" data-input-kind={inputKind} data-session-id={sessionId} />
  ),
}))

const { ScienceAnalysis } = await import("./ScienceAnalysis")

/**
 * Component test for the Analysis science tab. Renders plain DOM
 * + hand-authored primitives, so jsdom suffices: we assert structure only — the
 * grouped file list, a CSV table preview, the metadata fallback, and the empty /
 * no-projects states — never copy text or shadcn classes.
 */

function renderAnalysis(
  handlers: FakeHandlers,
  initialProjectId?: string,
  focusSession?: FocusSessionRequest,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({
    "science.analysis.getStructure": () => ({
      filePath: "/data/experiments-structure.yaml",
      defaultValue: "auto",
      projectValue: null,
    }),
    ...handlers,
  })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <ScienceAnalysis initialProjectId={initialProjectId} focusSession={focusSession ?? null} />
    </AppProviders>,
  )
}

function project(overrides: Partial<Project> & Pick<Project, "id" | "name">): Project {
  return {
    repoPath: `/repos/${overrides.name}`,
    defaultBranch: "main",
    color: null,
    thumbnail: null,
    gradient: null,
    digitalRain: false,
    metadata: null,
    taskRelPath: null,
    mainRelPath: null,
    typeId: "general",
    agentConfig: null,
    sortIndex: 0,
    sortOrder: null,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: 0,
    ...overrides,
  }
}

function listing(
  files: Array<{
    relPath: string
    name: string
    kind: string
    group?: string | null
    experiment?: string | null
    /** The path inside its row; the file name by default. */
    innerPath?: string
    inReportsFolder?: boolean
  }>,
) {
  // Group the way the router does (canonical kind order isn't asserted here).
  const byKind = new Map<string, typeof files>()
  for (const f of files) {
    const arr = byKind.get(f.kind) ?? []
    arr.push(f)
    byKind.set(f.kind, arr)
  }
  return {
    groups: [...byKind.entries()].map(([kind, fs]) => ({
      kind,
      files: fs.map((f) => ({
        ...f,
        group: f.group ?? null,
        experiment: f.experiment ?? null,
        innerPath: f.innerPath ?? f.name,
        inReportsFolder: f.inReportsFolder ?? false,
        size: 10,
        mtime: 0,
      })),
    })),
    total: files.length,
    truncatedExperiments: [] as Array<{
      group: string | null
      experiment: string | null
      inReportsFolder: boolean
    }>,
    partial: false,
    skipped: [],
    resultsFolder: "results",
    overridden: false,
    exists: true,
    plainFolders: false,
  }
}

describe("ScienceAnalysis", () => {
  beforeEach(() => {
    window.localStorage.clear()
    mocks.navigate.mockReset()
  })
  afterEach(() => setInterfaceLanguage("en"))

  test("opens the project requested by its dashboard card", async () => {
    const listFiles = vi.fn(() => listing([]))
    renderAnalysis(
      {
        "projects.list": () => [
          project({ id: "first", name: "First" }),
          project({ id: "selected", name: "Selected" }),
        ],
        "science.analysis.listFiles": listFiles,
      },
      "selected",
    )
    await waitFor(() =>
      expect(screen.getByTestId("analysis-project-select")).toHaveProperty("value", "selected"),
    )
    expect(listFiles).toHaveBeenCalledWith({
      projectId: "selected",
      defaultResultsFolder: "results",
    })
    expect(listFiles).not.toHaveBeenCalledWith({
      projectId: "first",
      defaultResultsFolder: "results",
    })
  })

  test("shows Analysis guidance in the selected interface language", async () => {
    setInterfaceLanguage("zh-CN")
    renderAnalysis({ "projects.list": () => [] })

    expect(await screen.findByText("实验日志与可视化")).toBeTruthy()
    expect(screen.getByText("没有打开的项目")).toBeTruthy()
  })

  test("Report starts the report agent for the selected project and Marimo report creation stays hidden", async () => {
    const startReport = vi.fn(() => ({
      sessionId: "report-1",
      workspaceId: "ws-1",
      kind: "branch",
      agentId: "claude-code",
      warning: null,
    }))
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () => listing([]),
      "sessions.startReport": startReport,
    })

    await waitFor(() =>
      expect(screen.getByTestId("analysis-project-select")).toHaveProperty("value", "p1"),
    )
    const button = await screen.findByTestId("analysis-report")
    // An icon-only top bar button, named in its hover tip.
    expect(button.textContent).toBe("")
    expect(button.getAttribute("data-feature-label")).toBe("Report")
    fireEvent.click(button)
    await waitFor(() => expect(startReport).toHaveBeenCalledWith({ projectId: "p1" }))
    expect(screen.queryByTestId("analysis-new-marimo-notebook")).toBeNull()
  })

  test("fetches experiments for the selected Git project and disables plain folders", async () => {
    window.localStorage.setItem("pi-lab.fetchExperiments.instructions", "Fetch only new results")
    const run = vi.fn(() => ({ status: "started" }))
    renderAnalysis({
      "projects.list": () => [
        project({ id: "git", name: "Git" }),
        project({ id: "plain", name: "Plain" }),
      ],
      "projects.capabilities": (input) => ({ git: (input as { id: string }).id === "git" }),
      "science.analysis.listFiles": () => listing([]),
      "workflows.status": () => ({ summary: null, fetchExperiments: null, planResearch: null }),
      "workflows.run": run,
      "workflows.onOutput": () => ({ kind: "start", command: "" }),
    })
    await waitFor(() =>
      expect(screen.getByTestId("analysis-fetch-experiments")).toHaveProperty("disabled", false),
    )
    fireEvent.click(screen.getByTestId("analysis-fetch-experiments"))
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "git",
          task: "fetch-experiments",
          instructions: "Fetch only new results",
        }),
      ),
    )
    fireEvent.click(await screen.findByTestId("workflow-result-close"))
    fireEvent.click(screen.getByTestId("analysis-project-select"))
    fireEvent.click(screen.getByRole("option", { name: "Plain" }))
    await waitFor(() =>
      expect(screen.getByTestId("analysis-fetch-experiments")).toHaveProperty("disabled", true),
    )
  })

  test("disables fetching when no project is selected", async () => {
    renderAnalysis({ "projects.list": () => [] })
    expect(await screen.findByTestId("analysis-fetch-experiments")).toHaveProperty("disabled", true)
  })

  test("shows the results folder above the search and groups files by experiment", async () => {
    window.localStorage.setItem("pi-lab.experiments.resultsFolder", "outputs")
    const listFiles = vi.fn(() => ({
      ...listing([
        { relPath: "outputs/summary.json", name: "summary.json", kind: "json", experiment: null },
        { relPath: "outputs/exp-b/log.txt", name: "log.txt", kind: "text", experiment: "exp-b" },
        { relPath: "outputs/exp-a/plot.png", name: "plot.png", kind: "image", experiment: "exp-a" },
      ]),
      resultsFolder: "outputs",
    }))
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": listFiles,
    })

    const folder = await screen.findByTestId("analysis-results-folder")
    await waitFor(() =>
      expect(within(folder).getByTestId("analysis-results-folder-path").textContent).toBe(
        "outputs/",
      ),
    )
    // The default folder is in use, so there is nothing to reset.
    expect(within(folder).queryByTestId("analysis-results-folder-reset")).toBeNull()
    expect(listFiles).toHaveBeenCalledWith({ projectId: "p1", defaultResultsFolder: "outputs" })
    // The folder field comes before the search bar.
    expect(
      folder.compareDocumentPosition(screen.getByTestId("analysis-search")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    await waitFor(() => expect(screen.getAllByTestId("analysis-experiment")).toHaveLength(3))
    const groups = screen.getAllByTestId("analysis-experiment-group")
    expect(groups.map((group) => group.getAttribute("data-experiment"))).toEqual([
      "exp-a",
      "exp-b",
      "",
    ])
    expect(within(groups[2] as HTMLElement).getByText("No experiment")).toBeTruthy()
    // Collapsed by default: no files until a row is opened.
    expect(screen.queryAllByTestId("analysis-file")).toHaveLength(0)
    fireEvent.click(within(groups[0] as HTMLElement).getByTestId("analysis-experiment"))
    expect(
      within(groups[0] as HTMLElement)
        .getAllByTestId("analysis-file")
        .map((row) => row.getAttribute("data-rel-path")),
    ).toEqual(["outputs/exp-a/plot.png"])

    // The category filters narrow the rows; the search opens the rows that match.
    fireEvent.click(screen.getByTestId("analysis-category-text"))
    expect(
      screen.getAllByTestId("analysis-experiment").map((row) => row.dataset.experiment),
    ).toEqual(["exp-b"])
    fireEvent.click(screen.getByTestId("analysis-category-all"))
    fireEvent.change(screen.getByTestId("analysis-search"), { target: { value: "log.txt" } })
    expect(screen.getAllByTestId("analysis-file").map((row) => row.dataset.relPath)).toEqual([
      "outputs/exp-b/log.txt",
    ])
    expect(screen.getAllByTestId("analysis-experiment-group")).toHaveLength(1)
  })

  test("lists the project's reports/ folder as its own group after the experiments", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([
          {
            relPath: "reports/report.html",
            name: "report.html",
            kind: "report",
            inReportsFolder: true,
          },
          { relPath: "results/exp-a/log.txt", name: "log.txt", kind: "text", experiment: "exp-a" },
          { relPath: "results/top.json", name: "top.json", kind: "json" },
        ]),
    })
    await waitFor(() => expect(screen.getAllByTestId("analysis-experiment")).toHaveLength(3))
    const groups = screen.getAllByTestId("analysis-experiment-group")
    expect(groups.map((group) => group.getAttribute("data-experiment"))).toEqual(["exp-a", ""])
    const reports = screen.getByTestId("analysis-reports-group")
    expect(within(reports).getByText("Reports (reports/)")).toBeTruthy()
    fireEvent.click(within(reports).getByTestId("analysis-experiment"))
    expect(
      within(reports)
        .getAllByTestId("analysis-file")
        .map((row) => row.dataset.relPath),
    ).toEqual(["reports/report.html"])
    // The reports group comes after the experiment groups.
    expect(
      (groups[1] as HTMLElement).compareDocumentPosition(reports) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  test("groups hold collapsed experiment rows; an experiment shows its folder tree, folders first", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([
          {
            relPath: "results/group_b/early-run/training_curve.pdf",
            name: "training_curve.pdf",
            kind: "pdf",
            group: "group_b",
            experiment: "early-run",
          },
          {
            relPath: "results/group_b/early-run/animations/growth.mp4",
            name: "growth.mp4",
            kind: "video",
            group: "group_b",
            experiment: "early-run",
            innerPath: "animations/growth.mp4",
          },
          {
            relPath: "results/group_b/full-run/grid.png",
            name: "grid.png",
            kind: "image",
            group: "group_b",
            experiment: "full-run",
          },
          {
            relPath: "results/group_a/20250101_120000/best.csv",
            name: "best.csv",
            kind: "csv",
            group: "group_a",
            experiment: "20250101_120000",
          },
          {
            relPath: "results/group_a/notes.txt",
            name: "notes.txt",
            kind: "text",
            group: "group_a",
          },
          { relPath: "results/summary.json", name: "summary.json", kind: "json" },
        ]),
    })
    // Top rows: the groups, then the loose files; all collapsed, no counts.
    const groups = await screen.findAllByTestId("analysis-group")
    expect(groups.map((row) => [row.dataset.group, row.textContent, row.ariaExpanded])).toEqual([
      ["group_a", "group_a", "false"],
      ["group_b", "group_b", "false"],
    ])
    expect(
      screen.getAllByTestId("analysis-experiment").map((row) => row.dataset.experiment),
    ).toEqual([""])
    expect(screen.queryAllByTestId("analysis-file")).toHaveLength(0)

    // A group lists its experiments (collapsed), then its own files.
    fireEvent.click(groups[1] as HTMLElement)
    const experiments = screen
      .getAllByTestId("analysis-experiment")
      .map((row) => [row.dataset.experiment, row.ariaExpanded])
    expect(experiments).toEqual([
      ["early-run", "false"],
      ["full-run", "false"],
      ["", "false"],
    ])
    fireEvent.click(groups[0] as HTMLElement)
    const group_a = screen.getAllByTestId("analysis-group-contents")[0] as HTMLElement
    expect(
      within(group_a)
        .getAllByTestId("analysis-file")
        .map((row) => row.dataset.relPath),
    ).toEqual(["results/group_a/notes.txt"])

    // An experiment shows its tree: the animations/ folder (collapsed) before its files.
    const grouse = screen
      .getAllByTestId("analysis-experiment")
      .find((row) => row.dataset.experiment === "early-run") as HTMLElement
    fireEvent.click(grouse)
    const files = screen.getAllByTestId("analysis-experiment-files")[0] as HTMLElement
    expect(
      [
        ...files.querySelectorAll('[data-testid="analysis-folder"], [data-testid="analysis-file"]'),
      ].map((row) => (row as HTMLElement).dataset.folder ?? (row as HTMLElement).dataset.relPath),
    ).toEqual(["animations", "results/group_b/early-run/training_curve.pdf"])
    fireEvent.click(within(files).getByTestId("analysis-folder"))
    expect(within(files).getAllByTestId("analysis-file")).toHaveLength(2)

    // Chips hide folders with no matching files; a search opens the matching folders.
    fireEvent.click(screen.getByTestId("analysis-category-figure"))
    expect(screen.queryAllByTestId("analysis-folder")).toHaveLength(0)
    fireEvent.click(screen.getByTestId("analysis-category-all"))
    fireEvent.click(grouse)
    fireEvent.change(screen.getByTestId("analysis-search"), { target: { value: "growth" } })
    expect(screen.getAllByTestId("analysis-file").map((row) => row.dataset.relPath)).toEqual([
      "results/group_b/early-run/animations/growth.mp4",
    ])
    expect(screen.getByTestId("analysis-folder").ariaExpanded).toBe("true")
  })

  test("a row cut at the file cap says so when opened; other rows do not", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () => ({
        ...listing([
          { relPath: "results/bulk/f0.csv", name: "f0.csv", kind: "csv", experiment: "bulk" },
          {
            relPath: "results/zz/run/x.csv",
            name: "x.csv",
            kind: "csv",
            experiment: "zz",
            innerPath: "run/x.csv",
          },
        ]),
        truncatedExperiments: [{ group: null, experiment: "bulk", inReportsFolder: false }],
      }),
    })
    const rows = await screen.findAllByTestId("analysis-experiment")
    expect(rows.map((row) => row.dataset.experiment)).toEqual(["bulk", "zz"])
    expect(screen.queryByTestId("analysis-experiment-truncated")).toBeNull()
    fireEvent.click(rows[0] as HTMLElement)
    fireEvent.click(rows[1] as HTMLElement)
    const notices = screen.getAllByTestId("analysis-experiment-truncated")
    expect(notices).toHaveLength(1)
    expect(
      screen.getAllByTestId("analysis-experiment-files")[0]?.contains(notices[0] ?? null),
    ).toBe(true)
  })

  test("with no experiments folder, no folder is shown and Select… is highlighted until clicked", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () => ({ ...listing([]), exists: false }),
      "system.pickDirectory": () => null,
    })
    const prompt = await screen.findByTestId("analysis-select-folder-prompt")
    expect(prompt.textContent).toBe("Select experiments folder")
    expect(screen.queryByTestId("analysis-results-folder-path")).toBeNull()
    const button = screen.getByTestId("analysis-results-folder-change")
    expect(button.textContent).toBe("Select…")
    expect(button.getAttribute("data-highlighted")).toBe("true")
    expect(button.className).toContain("analysis-select-folder-glow")
    fireEvent.click(button)
    expect(button.getAttribute("data-highlighted")).toBe("false")
    expect(button.className).not.toContain("analysis-select-folder-glow")
    // The prompt stays until a folder is chosen.
    expect(screen.getByTestId("analysis-select-folder-prompt")).toBeTruthy()
  })

  test("Folders shows the results folder as a plain tree: folders and files as rows, no experiment rows", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () => ({
        ...listing([
          {
            relPath: "results/exp-a/plot.png",
            name: "plot.png",
            kind: "image",
            innerPath: "exp-a/plot.png",
          },
          {
            relPath: "results/exp-a/runs/m.csv",
            name: "m.csv",
            kind: "csv",
            innerPath: "exp-a/runs/m.csv",
          },
          {
            relPath: "results/summary.json",
            name: "summary.json",
            kind: "json",
            innerPath: "summary.json",
          },
          { relPath: "reports/r.md", name: "r.md", kind: "markdown", inReportsFolder: true },
        ]),
        plainFolders: true,
      }),
    })
    await waitFor(() => expect(screen.getAllByTestId("analysis-folder")).toHaveLength(1))
    // The folder and the root file are rows of the tree; nothing is an experiment row.
    expect(screen.queryByText("No experiment")).toBeNull()
    expect(
      screen.getAllByTestId("analysis-folder").map((row) => row.getAttribute("data-folder")),
    ).toEqual(["exp-a"])
    expect(
      screen.getAllByTestId("analysis-file").map((row) => row.getAttribute("data-rel-path")),
    ).toEqual(["results/summary.json"])
    fireEvent.click(screen.getAllByTestId("analysis-folder")[0] as HTMLElement)
    expect(
      screen.getAllByTestId("analysis-folder").map((row) => row.getAttribute("data-folder")),
    ).toEqual(["exp-a", "exp-a/runs"])
  })

  test("the project's structure is chosen below the folder field and saved for the project", async () => {
    const setStructure = vi.fn(() => ({
      filePath: "/data/experiments-structure.yaml",
      defaultValue: "auto",
      projectValue: "experiment-run",
    }))
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () => listing([]),
      "science.analysis.setStructure": setStructure,
    })
    const select = (await screen.findByTestId("analysis-structure")) as HTMLSelectElement
    // With no entry of its own, the project shows the default from Settings.
    await waitFor(() => expect(select.value).toBe("auto"))
    // Only the real options, no "Default (…)" entry.
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Auto-detect",
      "Folders",
      "One folder per experiment",
      "Experiment / run folders",
      "Flat file list",
      "Custom pattern",
    ])
    expect(select.title).toContain("/data/experiments-structure.yaml")
    fireEvent.change(select, { target: { value: "experiment-run" } })
    await waitFor(() =>
      expect(setStructure).toHaveBeenCalledWith({ projectId: "p1", value: "experiment-run" }),
    )

    fireEvent.change(select, { target: { value: "custom" } })
    const pattern = screen.getByTestId("analysis-structure-pattern") as HTMLInputElement
    fireEvent.change(pattern, { target: { value: "{experiment}/seeds/{run}/" } })
    fireEvent.click(screen.getByTestId("analysis-structure-pattern-save"))
    await waitFor(() =>
      expect(setStructure).toHaveBeenCalledWith({
        projectId: "p1",
        value: "{experiment}/seeds/{run}/",
      }),
    )
  })

  test("the select shows the project's own saved choice over the default", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () => listing([]),
      "science.analysis.getStructure": () => ({
        filePath: "/data/experiments-structure.yaml",
        defaultValue: "flat",
        projectValue: "experiment-run",
      }),
    })
    const select = (await screen.findByTestId("analysis-structure")) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe("experiment-run"))
  })

  test("a saved custom pattern can be edited directly", async () => {
    const setStructure = vi.fn(() => ({
      filePath: "/data/experiments-structure.yaml",
      defaultValue: "auto",
      projectValue: "{experiment}/*/{run}/",
    }))
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () => listing([]),
      "science.analysis.getStructure": () => ({
        filePath: "/data/experiments-structure.yaml",
        defaultValue: "auto",
        projectValue: "{experiment}/seeds/{run}/",
      }),
      "science.analysis.setStructure": setStructure,
    })
    const select = (await screen.findByTestId("analysis-structure")) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe("custom"))
    // The saved pattern is shown for editing, with no other choice picked first.
    const pattern = (await screen.findByTestId("analysis-structure-pattern")) as HTMLInputElement
    expect(pattern.value).toBe("{experiment}/seeds/{run}/")
    fireEvent.change(pattern, { target: { value: "{experiment}/*/{run}/" } })
    fireEvent.click(screen.getByTestId("analysis-structure-pattern-save"))
    await waitFor(() =>
      expect(setStructure).toHaveBeenCalledWith({
        projectId: "p1",
        value: "{experiment}/*/{run}/",
      }),
    )
  })

  test("an invalid structure file shows its error in Analysis", async () => {
    const message =
      "Invalid experiments structure file /data/experiments-structure.yaml: bad indentation"
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () => {
        throw new Error(message)
      },
      "science.analysis.getStructure": () => {
        throw new Error(message)
      },
    })
    expect((await screen.findByTestId("analysis-structure-error")).textContent).toBe(message)
    expect((await screen.findByTestId("analysis-list-error")).textContent).toContain(message)
  })

  test("a missing results folder still lists the reports/ folder below the notice", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () => ({
        ...listing([
          {
            relPath: "reports/report.html",
            name: "report.html",
            kind: "report",
            inReportsFolder: true,
          },
        ]),
        exists: false,
      }),
    })
    expect(await screen.findByTestId("analysis-results-missing")).toBeTruthy()
    const reports = await screen.findByTestId("analysis-reports-group")
    fireEvent.click(within(reports).getByTestId("analysis-experiment"))
    expect(within(reports).getByTestId("analysis-file")).toBeTruthy()
  })

  test("says plainly when the results folder does not exist, and offers Change…", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () => ({ ...listing([]), exists: false }),
    })
    const missing = await screen.findByTestId("analysis-results-missing")
    expect(missing.textContent).toContain("No results/ folder in this project")
    expect(missing.textContent).toContain("Use Select… above")
    // The notice is in the preview card; the file list card keeps the folder field.
    expect(screen.getByTestId("analysis-preview-column").contains(missing)).toBe(true)
    expect(screen.queryByTestId("analysis-no-selection")).toBeNull()
    const files = screen.getByTestId("analysis-files-column")
    expect(files.contains(missing)).toBe(false)
    expect(screen.queryByTestId("science-analysis-empty")).toBeNull()
    expect(within(files).getByTestId("analysis-results-folder-change")).toBeTruthy()
    expect(within(files).getByTestId("analysis-search")).toBeTruthy()
  })

  test("Change… saves a picked folder for the project, and Reset to default clears it", async () => {
    let own: string | null = null
    const setResultsFolder = vi.fn((input: unknown) => {
      const dir = (input as { dir: string | null }).dir
      own = dir === null ? null : "runs/out"
      return { resultsFolder: own }
    })
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () => ({
        ...listing([]),
        resultsFolder: own ?? "results",
        overridden: own !== null,
        exists: own !== null,
      }),
      "system.pickDirectory": () => "/repos/alpha/runs/out",
      "science.analysis.setResultsFolder": setResultsFolder,
    })

    fireEvent.click(await screen.findByTestId("analysis-results-folder-change"))
    await waitFor(() =>
      expect(setResultsFolder).toHaveBeenCalledWith({
        projectId: "p1",
        dir: "/repos/alpha/runs/out",
      }),
    )
    await waitFor(() =>
      expect(screen.getByTestId("analysis-results-folder-path").textContent).toBe("runs/out/"),
    )

    fireEvent.click(screen.getByTestId("analysis-results-folder-reset"))
    await waitFor(() =>
      expect(setResultsFolder).toHaveBeenLastCalledWith({ projectId: "p1", dir: null }),
    )
    // The default results/ does not exist in this project, so no folder is shown.
    expect(await screen.findByTestId("analysis-select-folder-prompt")).toBeTruthy()
    expect(screen.queryByTestId("analysis-results-folder-reset")).toBeNull()
  })

  test("shows why a picked folder was refused", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () => listing([]),
      "system.pickDirectory": () => "/elsewhere",
      "science.analysis.setResultsFolder": async () => {
        throw new Error("The results folder must be inside the project: /elsewhere")
      },
    })
    fireEvent.click(await screen.findByTestId("analysis-results-folder-change"))
    expect((await screen.findByTestId("analysis-results-folder-error")).textContent).toContain(
      "must be inside the project",
    )
  })

  test("renders a row per discovered file", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([
          { relPath: "data/metrics.csv", name: "metrics.csv", kind: "csv" },
          { relPath: "config.json", name: "config.json", kind: "json" },
        ]),
    })

    await waitFor(() => {
      expect(screen.getAllByTestId("analysis-file")).toHaveLength(2)
    })
    const paths = screen
      .getAllByTestId("analysis-file")
      .map((el) => el.getAttribute("data-rel-path"))
    // Sorted by name, like the file tree.
    expect(paths).toEqual(["config.json", "data/metrics.csv"])
  })

  test("shows a partial warning alongside readable files", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () => ({
        ...listing([{ relPath: "data.csv", name: "data.csv", kind: "csv" }]),
        partial: true,
        skipped: ["private"],
      }),
    })
    expect(await screen.findByTestId("analysis-file")).toBeTruthy()
    expect(screen.getByTestId("analysis-partial").textContent).toContain("1")
  })

  test("shows a partial warning when no child was readable", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () => ({
        ...listing([]),
        partial: true,
        skipped: ["private"],
      }),
    })
    expect(await screen.findByTestId("analysis-partial")).toBeTruthy()
    expect(screen.getByTestId("science-analysis-empty")).toBeTruthy()
  })

  test("Escape deselects the file, but not while typing in a field or with a dialog open", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([{ relPath: "plot.png", name: "plot.png", kind: "image" }]),
      "science.analysis.preview": () => ({ type: "image", dataUrl: "data:image/png;base64," }),
    })
    fireEvent.click(await screen.findByTestId("analysis-file"))
    expect(await screen.findByTestId("analysis-preview-path")).toBeTruthy()

    // In the search box Escape stays with the field.
    const search = screen.getByTestId("analysis-search")
    search.focus()
    fireEvent.keyDown(search, { key: "Escape" })
    expect(screen.getByTestId("analysis-preview-path")).toBeTruthy()
    search.blur()

    // With a dialog open, Escape is the dialog's.
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    document.body.append(dialog)
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.getByTestId("analysis-preview-path")).toBeTruthy()
    dialog.remove()

    fireEvent.keyDown(window, { key: "Escape" })
    expect(await screen.findByTestId("analysis-no-selection")).toBeTruthy()
    expect(screen.queryByTestId("analysis-preview-path")).toBeNull()
  })

  test("a click on empty space deselects the file; clicks on files, controls or the preview content do not", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([
          { relPath: "plot.png", name: "plot.png", kind: "image" },
          { relPath: "m.csv", name: "m.csv", kind: "csv" },
        ]),
      "science.analysis.preview": () => ({ type: "image", dataUrl: "data:image/png;base64," }),
    })
    const select = async (): Promise<void> => {
      const row = (await screen.findAllByTestId("analysis-file")).find(
        (element) => element.dataset.relPath === "plot.png",
      ) as HTMLElement
      fireEvent.click(row)
      await screen.findByTestId("analysis-preview-path")
    }
    await select()
    // Controls, the preview content and the right panel keep the selection.
    fireEvent.click(screen.getByTestId("analysis-category-figure"))
    fireEvent.click(screen.getByTestId("analysis-category-all"))
    fireEvent.click(screen.getByTestId("analysis-search"))
    fireEvent.click(await screen.findByTestId("analysis-preview-image"))
    fireEvent.click(screen.getByTestId("science-sessions"))
    expect(screen.getByTestId("analysis-preview-path")).toBeTruthy()

    // The empty area of the list deselects.
    fireEvent.click(screen.getByTestId("analysis-files-list"))
    expect(await screen.findByTestId("analysis-no-selection")).toBeTruthy()
    // So does the preview pane's empty area.
    await select()
    fireEvent.click(screen.getByTestId("analysis-preview"))
    expect(await screen.findByTestId("analysis-no-selection")).toBeTruthy()
  })

  test("the folder tree can be hidden: files are listed directly with their path, and the choice is kept", async () => {
    const files = listing([
      {
        relPath: "results/group_b/early-run/animations/growth.gif",
        name: "growth.gif",
        kind: "animation",
        group: "group_b",
        experiment: "early-run",
        innerPath: "animations/growth.gif",
      },
      {
        relPath: "results/group_b/early-run/curve.pdf",
        name: "curve.pdf",
        kind: "pdf",
        group: "group_b",
        experiment: "early-run",
      },
      { relPath: "results/summary.json", name: "summary.json", kind: "json" },
    ])
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () => files,
    })
    const toggle = await screen.findByTestId("analysis-flat-toggle")
    // Off by default: the tree, with its group row.
    expect(toggle.getAttribute("aria-pressed")).toBe("false")
    expect(toggle.getAttribute("aria-label")).toBe("Hide folders")
    expect(toggle.dataset.featureLabel).toBe("Hide folders")
    // The lucide ListTree icon.
    expect(toggle.querySelector("svg")?.getAttribute("class")).toContain("lucide-list-tree")
    expect(toggle.dataset.featureHelp).toBeTruthy()
    await screen.findAllByTestId("analysis-group")

    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-pressed")).toBe("true")
    expect(screen.queryAllByTestId("analysis-group")).toHaveLength(0)
    expect(screen.queryAllByTestId("analysis-folder")).toHaveLength(0)
    const rows = screen.getAllByTestId("analysis-file")
    expect(rows.map((row) => row.dataset.relPath)).toEqual([
      "results/group_b/early-run/animations/growth.gif",
      "results/group_b/early-run/curve.pdf",
      "results/summary.json",
    ])
    expect(rows[0]?.textContent).toContain(
      "results/group_b/early-run/animations/growth.gif",
    )
    expect(window.localStorage.getItem("pi-lab.analysis.flatList")).toBe("true")

    // Chips still apply.
    fireEvent.click(screen.getByTestId("analysis-category-figure"))
    expect(screen.getAllByTestId("analysis-file").map((row) => row.dataset.relPath)).toEqual([
      "results/group_b/early-run/curve.pdf",
    ])
  })

  test("selecting a CSV file renders a table preview", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([{ relPath: "d.csv", name: "d.csv", kind: "csv" }]),
      "science.analysis.preview": () => ({
        type: "table",
        headers: ["name", "value"],
        rows: [
          ["alpha", "1"],
          ["beta", "2"],
        ],
        totalRows: 2,
        truncated: false,
      }),
    })

    await waitFor(() => {
      expect(screen.getByTestId("analysis-file")).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId("analysis-file"))

    await waitFor(() => {
      expect(screen.getByTestId("analysis-preview-table")).toBeTruthy()
    })
    // Two header cells + four body cells.
    const table = screen.getByTestId("analysis-preview-table")
    expect(table.querySelectorAll("thead th")).toHaveLength(2)
    expect(table.querySelectorAll("tbody td")).toHaveLength(4)
  })

  test("selecting a metric file renders the line chart with a series legend", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([{ relPath: "runs/loss.npy", name: "loss.npy", kind: "npy" }]),
      "science.analysis.preview": () => ({
        type: "chart",
        xLabel: "index",
        x: [0, 1, 2],
        series: [
          { label: "loss", values: [1, 0.6, 0.3] },
          { label: "reward", values: [0.1, 0.4, 0.7] },
        ],
        truncated: false,
      }),
    })

    await waitFor(() => {
      expect(screen.getByTestId("analysis-file")).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId("analysis-file"))

    await waitFor(() => {
      expect(screen.getByTestId("analysis-preview-chart")).toBeTruthy()
    })
    const legend = screen.getByTestId("analysis-chart-legend")
    expect(legend.textContent).toContain("loss")
    expect(legend.textContent).toContain("reward")
  })

  test("selecting a 2-D NumPy array renders the array grid", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([{ relPath: "mat.npy", name: "mat.npy", kind: "npy" }]),
      "science.analysis.preview": () => ({
        type: "array",
        dtype: "<f8",
        shape: [2, 3],
        columns: ["c0", "c1", "c2"],
        rows: [
          ["1", "2", "3"],
          ["4", "5", "6"],
        ],
        truncated: false,
      }),
    })

    await waitFor(() => {
      expect(screen.getByTestId("analysis-file")).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId("analysis-file"))

    await waitFor(() => {
      expect(screen.getByTestId("analysis-preview-array")).toBeTruthy()
    })
    const table = screen.getByTestId("analysis-preview-array")
    // Three value columns + the row-index gutter header.
    expect(table.querySelectorAll("thead th")).toHaveLength(4)
    // Two rows × (3 value cells + 1 index cell).
    expect(table.querySelectorAll("tbody td")).toHaveLength(8)
  })

  test("selecting an unpreviewable file renders the metadata fallback", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([{ relPath: "m.parquet", name: "m.parquet", kind: "parquet" }]),
      "science.analysis.preview": () => ({
        type: "metadata",
        kind: "parquet",
        size: 2048,
        mtime: 0,
      }),
    })

    await waitFor(() => {
      expect(screen.getByTestId("analysis-file")).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId("analysis-file"))

    await waitFor(() => {
      expect(screen.getByTestId("analysis-preview-metadata")).toBeTruthy()
    })
  })

  test("selecting an HTML report renders a script-only sandbox without app capabilities", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([{ relPath: "reports/live.html", name: "live.html", kind: "report" }]),
      "science.analysis.openInteractive": () => ({
        type: "html",
        url: "pi-lab-report://report-token/live.html",
      }),
      "science.analysis.closeInteractive": () => undefined,
    })

    fireEvent.click(await screen.findByTestId("analysis-file"))

    const frame = (await screen.findByTestId("analysis-preview-html")) as HTMLIFrameElement
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms")
    expect(frame.getAttribute("src")).toBe("pi-lab-report://report-token/live.html")
    expect(frame.hasAttribute("allow")).toBe(false)
  })

  test("marimo startup errors are visible and switching artifacts requests cleanup", async () => {
    const closes: unknown[] = []
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([
          { relPath: "reports/live.py", name: "live.py", kind: "marimo" },
          { relPath: "data.csv", name: "data.csv", kind: "csv" },
        ]),
      "science.analysis.openInteractive": () =>
        Promise.reject(new Error("marimo is not installed")),
      "science.analysis.closeInteractive": (input) => {
        closes.push(input)
      },
      "science.analysis.preview": () => ({
        type: "table",
        headers: ["value"],
        rows: [["1"]],
        totalRows: 1,
        truncated: false,
      }),
    })

    await waitFor(() => expect(screen.getAllByTestId("analysis-file")).toHaveLength(2))
    // Canonical grouping places CSV before marimo, so select by stable path.
    fireEvent.click(
      document.querySelector(
        '[data-testid="analysis-file"][data-rel-path="reports/live.py"]',
      ) as HTMLElement,
    )
    expect((await screen.findByTestId("analysis-interactive-error")).textContent).toContain(
      "marimo is not installed",
    )

    fireEvent.click(
      document.querySelector(
        '[data-testid="analysis-file"][data-rel-path="data.csv"]',
      ) as HTMLElement,
    )
    await waitFor(() => expect(closes).toHaveLength(1))
  })

  test("rapid interactive switches scope stale cleanup to the prior preview lease", async () => {
    const opens: Array<Record<string, unknown>> = []
    const closes: Array<Record<string, unknown>> = []
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([
          { relPath: "reports/first.html", name: "first.html", kind: "report" },
          { relPath: "reports/second.html", name: "second.html", kind: "report" },
        ]),
      "science.analysis.openInteractive": (input) => {
        opens.push(input as Record<string, unknown>)
        return {
          type: "html",
          url: `pi-lab-report://report-token/${String((input as Record<string, unknown>).relPath)}`,
        }
      },
      "science.analysis.closeInteractive": (input) => {
        closes.push(input as Record<string, unknown>)
      },
    })

    await waitFor(() => expect(screen.getAllByTestId("analysis-file")).toHaveLength(2))
    fireEvent.click(
      document.querySelector(
        '[data-testid="analysis-file"][data-rel-path="reports/first.html"]',
      ) as HTMLElement,
    )
    await screen.findByTestId("analysis-preview-html")

    fireEvent.click(
      document.querySelector(
        '[data-testid="analysis-file"][data-rel-path="reports/second.html"]',
      ) as HTMLElement,
    )
    await waitFor(() => expect(opens).toHaveLength(2))
    await waitFor(() => expect(closes).toHaveLength(1))

    expect(opens[0]?.ownerId).toBe(opens[1]?.ownerId)
    expect(closes[0]?.leaseId).toBe(opens[0]?.leaseId)
    expect(closes[0]?.leaseId).not.toBe(opens[1]?.leaseId)
  })

  test("marimo exposes running, stopping, and stopped states", async () => {
    let finishClose: () => void = () => {}
    const closing = new Promise<void>((resolve) => {
      finishClose = resolve
    })
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([{ relPath: "reports/live.py", name: "live.py", kind: "marimo" }]),
      "science.analysis.openInteractive": () => ({
        type: "marimo",
        url: "http://127.0.0.1:41000/",
        runtime: "project/.venv",
      }),
      "science.analysis.closeInteractive": () => closing,
    })

    fireEvent.click(await screen.findByTestId("analysis-file"))
    expect(await screen.findByTestId("analysis-marimo-status")).toBeTruthy()
    expect(screen.getByTestId("analysis-marimo-status").textContent).toContain("project/.venv")

    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    expect(await screen.findByTestId("analysis-interactive-stopping")).toBeTruthy()
    finishClose()
    expect(await screen.findByTestId("analysis-interactive-stopped")).toBeTruthy()
  })

  test("the search filter fuzzy-matches and highlights the visible rows", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([
          { relPath: "data/metrics.csv", name: "metrics.csv", kind: "csv" },
          { relPath: "config.json", name: "config.json", kind: "json" },
        ]),
    })

    await waitFor(() => {
      expect(screen.getAllByTestId("analysis-file")).toHaveLength(2)
    })

    fireEvent.change(screen.getByTestId("analysis-search"), { target: { value: "mtrcs" } })

    await waitFor(() => {
      expect(screen.getAllByTestId("analysis-file")).toHaveLength(1)
    })
    expect(screen.getByTestId("analysis-file").getAttribute("data-rel-path")).toBe(
      "data/metrics.csv",
    )
    expect(
      screen
        .getAllByTestId("analysis-match")
        .map((node) => node.textContent)
        .join(""),
    ).toBe("mtrcs")
  })

  test("⌘F opens a fuzzy finder over the analysis files; picking one previews it", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([
          { relPath: "data/metrics.csv", name: "metrics.csv", kind: "csv" },
          { relPath: "config.json", name: "config.json", kind: "json" },
        ]),
      "science.analysis.preview": () => ({
        type: "table",
        headers: ["name", "value"],
        rows: [["alpha", "1"]],
        totalRows: 1,
        truncated: false,
      }),
    })

    await waitFor(() => {
      expect(screen.getAllByTestId("analysis-file")).toHaveLength(2)
    })

    // The quick-open shortcut (⌘F) opens the finder over the data files (not projects).
    fireEvent.keyDown(window, { key: "f", metaKey: true })
    expect(screen.getByTestId("quick-find")).toBeTruthy()
    // Items are the files, id'd by their repo-relative path (the full list, unfiltered).
    const items = screen.getAllByTestId("quick-find-item")
    expect(items.map((el) => el.getAttribute("data-find-id"))).toEqual([
      "data/metrics.csv",
      "config.json",
    ])

    // Fuzzy-filtering on the basename narrows to the one match, and picking it selects
    // that file: the finder closes and its preview renders.
    fireEvent.change(screen.getByTestId("quick-find-input"), { target: { value: "metrics" } })
    const match = screen.getByTestId("quick-find-item")
    expect(match.getAttribute("data-find-id")).toBe("data/metrics.csv")
    fireEvent.click(match)

    expect(screen.queryByTestId("quick-find")).toBeNull()
    await waitFor(() => {
      expect(screen.getByTestId("analysis-preview-table")).toBeTruthy()
    })
  })

  test("filter chips are Data, Figures, Markup and Text, only those present", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([
          { relPath: "data/metrics.csv", name: "metrics.csv", kind: "csv" },
          { relPath: "runs/loss.npy", name: "loss.npy", kind: "npy" },
          { relPath: "figs/plot.png", name: "plot.png", kind: "image" },
          { relPath: "figs/grad.pdf", name: "grad.pdf", kind: "pdf" },
          { relPath: "config.yaml", name: "config.yaml", kind: "markup" },
          { relPath: "summary.json", name: "summary.json", kind: "json" },
          { relPath: "run.log", name: "run.log", kind: "text" },
          { relPath: "notes.md", name: "notes.md", kind: "markdown" },
        ]),
    })
    const filters = await screen.findByTestId("analysis-category-filters")
    expect(
      within(filters)
        .getAllByRole("button")
        .map((chip) => chip.textContent),
    ).toEqual(["All", "Data", "Figures", "Markup", "Text"])
    for (const old of ["Plots", "Images", "Logs"]) expect(filters.textContent).not.toContain(old)
  })

  test("a category shows a second row of smaller format chips; a format chip filters and clicking it again shows all", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([
          { relPath: "figs/grad.pdf", name: "grad.pdf", kind: "pdf" },
          { relPath: "figs/loss.png", name: "loss.png", kind: "image" },
          { relPath: "figs/arch.svg", name: "arch.svg", kind: "image" },
          { relPath: "data/metrics.csv", name: "metrics.csv", kind: "csv" },
        ]),
    })
    await waitFor(() => expect(screen.getAllByTestId("analysis-file")).toHaveLength(4))
    const formats = () =>
      within(screen.getByTestId("analysis-format-filters"))
        .getAllByRole("button")
        .map((chip) => chip.textContent)
    // All shows only the formats present, in the categories' fixed order.
    expect(formats()).toEqual(["CSV", "PNG", "PDF", "SVG"])
    expect(screen.queryByTestId("analysis-format-menu")).toBeNull()
    // Format chips are smaller than category chips.
    expect(screen.getByTestId("analysis-format-pdf").className).toContain("text-[10px]")
    expect(screen.getByTestId("analysis-category-all").className).not.toContain("text-[10px]")

    // A format chip from All filters to that format.
    fireEvent.click(screen.getByTestId("analysis-format-csv"))
    expect(screen.getAllByTestId("analysis-file").map((row) => row.dataset.relPath)).toEqual([
      "data/metrics.csv",
    ])
    fireEvent.click(screen.getByTestId("analysis-format-csv"))
    expect(screen.getAllByTestId("analysis-file")).toHaveLength(4)

    // Figures: its formats in the second row, no "All figures".
    const figures = screen.getByTestId("analysis-category-figure")
    fireEvent.click(figures)
    expect(formats()).toEqual(["PNG", "PDF", "SVG", "JPG"])
    expect(screen.queryByText("All figures")).toBeNull()
    expect(screen.getAllByTestId("analysis-file")).toHaveLength(3)

    const pdf = screen.getByTestId("analysis-format-pdf")
    fireEvent.click(pdf)
    expect(pdf.getAttribute("aria-pressed")).toBe("true")
    expect(screen.getAllByTestId("analysis-file").map((row) => row.dataset.relPath)).toEqual([
      "figs/grad.pdf",
    ])
    // Clicking it again goes back to all figures.
    fireEvent.click(pdf)
    expect(screen.getAllByTestId("analysis-file")).toHaveLength(3)
    // Clicking the selected category again does the same.
    fireEvent.click(screen.getByTestId("analysis-format-png"))
    expect(screen.getAllByTestId("analysis-file")).toHaveLength(1)
    fireEvent.click(figures)
    expect(screen.getAllByTestId("analysis-file")).toHaveLength(3)
  })

  test("a selected category lists its fixed formats; absent ones are greyed out and not clickable", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([
          { relPath: "figs/plot.png", name: "plot.png", kind: "image" },
          { relPath: "runs/growth.mp4", name: "growth.mp4", kind: "video" },
          { relPath: "runs/growth.gif", name: "growth.gif", kind: "animation" },
          { relPath: "runs/config.yml", name: "config.yml", kind: "markup" },
          { relPath: "runs/params.yaml", name: "params.yaml", kind: "markup" },
        ]),
    })
    const chips = () =>
      within(screen.getByTestId("analysis-format-filters"))
        .getAllByRole("button")
        .map((chip) => [chip.textContent, (chip as HTMLButtonElement).disabled])
    const figures = await screen.findByTestId("analysis-category-figure")
    // All: only the formats present (YAML and YML are one chip).
    expect(chips()).toEqual([
      ["PNG", false],
      ["MP4", false],
      ["GIF", false],
      ["YAML", false],
    ])
    fireEvent.click(figures)
    expect(chips()).toEqual([
      ["PNG", false],
      ["PDF", true],
      ["SVG", true],
      ["JPG", true],
    ])
    fireEvent.click(screen.getByTestId("analysis-category-animation"))
    expect(chips()).toEqual([
      ["MP4", false],
      ["GIF", false],
      ["WEBM", true],
      ["MOV", true],
      ["MKV", true],
    ])
    // A greyed-out chip does nothing.
    fireEvent.click(screen.getByTestId("analysis-format-webm"))
    expect(screen.getAllByTestId("analysis-file")).toHaveLength(2)
    fireEvent.click(screen.getByTestId("analysis-format-mp4"))
    expect(screen.getAllByTestId("analysis-file").map((row) => row.dataset.relPath)).toEqual([
      "runs/growth.mp4",
    ])
    // Markup: YAML covers .yaml and .yml.
    fireEvent.click(screen.getByTestId("analysis-category-markup"))
    expect(chips()).toEqual([
      ["YAML", false],
      ["TOML", true],
      ["JSON", true],
      ["XML", true],
    ])
    fireEvent.click(screen.getByTestId("analysis-format-yaml"))
    expect(
      screen
        .getAllByTestId("analysis-file")
        .map((row) => row.dataset.relPath)
        .sort(),
    ).toEqual(["runs/config.yml", "runs/params.yaml"])
  })

  test("the project picker sits in the top bar and switches the project and makes it current", async () => {
    renderAnalysis({
      "projects.list": () => [
        project({ id: "p1", name: "alpha" }),
        project({ id: "p2", name: "beta" }),
      ],
      "science.analysis.listFiles": (input) =>
        (input as { projectId: string }).projectId === "p1"
          ? listing([{ relPath: "a.csv", name: "a.csv", kind: "csv" }])
          : listing([{ relPath: "b.json", name: "b.json", kind: "json" }]),
    })

    const select = (await within(screen.getByRole("banner")).findByTestId(
      "analysis-project-select",
    )) as HTMLButtonElement
    await waitFor(() => {
      expect(screen.getByTestId("analysis-file").getAttribute("data-rel-path")).toBe("a.csv")
    })
    fireEvent.click(select)
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["alpha", "beta"])

    fireEvent.click(screen.getByRole("option", { name: "beta" }))
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/science/analysis",
      search: { projectId: "p2" },
      replace: true,
    })
    expect(window.localStorage.getItem("pi-lab.currentProject")).toBe("p2")
    await waitFor(() => {
      expect(screen.getByTestId("analysis-file").getAttribute("data-rel-path")).toBe("b.json")
    })
  })

  test("arriving with ?projectId makes it current; the picker then wins", async () => {
    renderAnalysis(
      {
        "projects.list": () => [
          project({ id: "p1", name: "alpha" }),
          project({ id: "p2", name: "beta" }),
        ],
        "science.analysis.listFiles": () => listing([]),
      },
      "p2",
    )
    const select = (await screen.findByTestId("analysis-project-select")) as HTMLButtonElement
    await waitFor(() => expect(select.value).toBe("p2"))
    expect(window.localStorage.getItem("pi-lab.currentProject")).toBe("p2")

    fireEvent.click(select)
    fireEvent.click(screen.getByRole("option", { name: "alpha" }))
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/science/analysis",
      search: { projectId: "p1" },
      replace: true,
    })
    expect(window.localStorage.getItem("pi-lab.currentProject")).toBe("p1")
  })

  test("arriving with an agent to focus opens it as the active tab of the session panel", async () => {
    renderAnalysis(
      {
        "projects.list": () => [
          project({ id: "p1", name: "alpha" }),
          project({ id: "p2", name: "beta" }),
        ],
        "science.analysis.listFiles": () => listing([]),
        "workspaces.ensureMain": () => ({ id: "ws-2" }),
        "settings.get": () => ({ agents: { defaultAgentId: "claude-code" } }),
        "agents.list": () => [],
        "agents.projectChoice": () => ({ agentId: null, storage: "app" }),
        "terminal.list": () => [{ id: "agent-9", alive: true }],
        "files.tree": () => [],
      },
      "p2",
      { sessionId: "agent-9", agentId: "claude-code", agentLabel: "Claude Code" },
    )
    const terminal = await screen.findByTestId("terminal")
    expect(terminal.getAttribute("data-session-id")).toBe("agent-9")
    expect(screen.getByTestId("science-sessions").getAttribute("data-collapsed")).toBe("false")
    const tab = screen.getByTestId("central-tab")
    expect(tab.getAttribute("data-active")).toBe("true")
    expect(tab.textContent).toContain("Claude Code")
  })

  test("opens on the current project", async () => {
    window.localStorage.setItem("pi-lab.currentProject", "p2")
    const listFiles = vi.fn(() => listing([]))
    renderAnalysis({
      "projects.list": () => [
        project({ id: "p1", name: "alpha" }),
        project({ id: "p2", name: "beta" }),
      ],
      "science.analysis.listFiles": listFiles,
    })
    const select = (await screen.findByTestId("analysis-project-select")) as HTMLButtonElement
    await waitFor(() => expect(select.value).toBe("p2"))
    expect(listFiles).toHaveBeenCalledWith({ projectId: "p2", defaultResultsFolder: "results" })
    expect(listFiles).not.toHaveBeenCalledWith({ projectId: "p1", defaultResultsFolder: "results" })
  })

  test("shows the empty state when the project has no data files", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () => ({ groups: [], total: 0, truncated: false }),
    })

    await waitFor(() => {
      expect(screen.getByTestId("science-analysis-empty")).toBeTruthy()
    })
    expect(screen.queryByTestId("analysis-file")).toBeNull()
  })

  test("shows the no-projects state when nothing is open", async () => {
    renderAnalysis({ "projects.list": () => [] })

    await waitFor(() => {
      expect(screen.getByTestId("science-analysis-no-projects")).toBeTruthy()
    })
    expect(screen.queryByTestId("analysis-file")).toBeNull()
  })
})

describe("Analysis preview formats (mocked server)", () => {
  /** Render one listed file, select it, and serve `preview` for it. */
  async function selectFile(
    file: { relPath: string; name: string; kind: string },
    handlers: FakeHandlers,
  ) {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () => listing([file]),
      ...handlers,
    })
    fireEvent.click(await screen.findByTestId("analysis-file"))
    return screen.findByTestId("analysis-preview")
  }

  test.each([
    ["results/run/analysis.md", "MyST"],
    ["results/run/analysis.qmd", "Quarto"],
  ])("%s renders as Markdown with its %s front matter hidden", async (relPath) => {
    const pane = await selectFile(
      { relPath, name: relPath.split("/").at(-1) ?? relPath, kind: "markdown" },
      {
        "science.analysis.preview": () => ({
          type: "text",
          text: "---\ntitle: Run 1\n---\n\n# Loss went down\n\nBy **10%**.\n",
          truncated: false,
        }),
      },
    )
    expect(await within(pane).findByRole("heading", { name: "Loss went down" })).toBeTruthy()
    expect(within(pane).getByText("10%").tagName).toBe("STRONG")
    expect(within(pane).queryByText(/title: Run 1/)).toBeNull()
  })

  test("a video plays muted and looping with controls from a media grant, revoked on switch", async () => {
    const openMedia = vi.fn(() => ({ url: "pi-lab-media://t1/growth.mp4" }))
    const closeMedia = vi.fn(() => undefined)
    const { unmount } = renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([{ relPath: "results/growth.mp4", name: "growth.mp4", kind: "video" }]),
      "science.analysis.openMedia": openMedia,
      "science.analysis.closeMedia": closeMedia,
    })
    fireEvent.click(await screen.findByTestId("analysis-file"))
    const video = (await screen.findByTestId("analysis-preview-video")) as HTMLVideoElement
    expect(openMedia).toHaveBeenCalledWith({ projectId: "p1", relPath: "results/growth.mp4" })
    expect(video.getAttribute("src")).toBe("pi-lab-media://t1/growth.mp4")
    expect(video.muted).toBe(true)
    expect(video.loop).toBe(true)
    expect(video.controls).toBe(true)
    unmount()
    await waitFor(() =>
      expect(closeMedia).toHaveBeenCalledWith({ url: "pi-lab-media://t1/growth.mp4" }),
    )
  })

  test("a gif shows as an animated image from a media grant", async () => {
    const pane = await selectFile(
      { relPath: "results/growth.gif", name: "growth.gif", kind: "animation" },
      {
        "science.analysis.openMedia": () => ({ url: "pi-lab-media://t2/growth.gif" }),
        "science.analysis.closeMedia": () => undefined,
      },
    )
    const image = await within(pane).findByTestId("analysis-preview-animation")
    expect(image.tagName).toBe("IMG")
    expect(image.getAttribute("src")).toBe("pi-lab-media://t2/growth.gif")
  })

  test("a Jupyter notebook shows Markdown cells, code cells and their stored outputs", async () => {
    const pane = await selectFile(
      { relPath: "results/run/analysis.ipynb", name: "analysis.ipynb", kind: "notebook" },
      {
        "science.analysis.preview": () => ({
          type: "notebook",
          cells: [
            { type: "markdown", source: "# Loss curve", outputs: [] },
            {
              type: "code",
              source: "plot(loss)",
              outputs: [
                { type: "text", text: "final loss 0.3" },
                { type: "image", dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
                { type: "unsupported", outputType: "display_data" },
              ],
            },
          ],
        }),
      },
    )
    expect(await within(pane).findByRole("heading", { name: "Loss curve" })).toBeTruthy()
    const cells = within(pane).getAllByTestId("analysis-notebook-cell")
    expect(cells.map((cell) => cell.dataset.cellType)).toEqual(["markdown", "code"])
    const code = cells[1] as HTMLElement
    expect(within(code).getByTestId("analysis-notebook-code").textContent).toBe("plot(loss)")
    expect(within(code).getByText("final loss 0.3")).toBeTruthy()
    expect(within(code).getByRole("img").getAttribute("src")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    )
    expect(within(code).getByText("Output not shown (display_data)")).toBeTruthy()
  })

  test("a marimo notebook is labelled, and shows its Python code when marimo cannot start", async () => {
    const pane = await selectFile(
      { relPath: "results/run/notebook.py", name: "notebook.py", kind: "marimo" },
      {
        "science.analysis.openInteractive": () =>
          Promise.reject(new Error("marimo is not installed")),
        "science.analysis.closeInteractive": () => undefined,
        "science.analysis.preview": () => ({
          type: "text",
          text: "import marimo\n\napp = marimo.App()\n",
          truncated: false,
        }),
      },
    )
    expect(screen.getByTestId("analysis-preview-label").textContent).toBe("marimo notebook")
    expect(await within(pane).findByTestId("analysis-interactive-error")).toBeTruthy()
    expect((await within(pane).findByTestId("analysis-preview-code")).textContent).toBe(
      "import marimo\n\napp = marimo.App()\n",
    )
  })
})
