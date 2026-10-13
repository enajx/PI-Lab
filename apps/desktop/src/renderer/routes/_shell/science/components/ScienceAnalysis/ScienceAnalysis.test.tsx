import type { Project } from "@pi-lab/local-db"
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"
import { setInterfaceLanguage } from "../../../../../i18n/language"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { ScienceAnalysis } from "./ScienceAnalysis"

/**
 * Component test for the Analysis science tab (md/engineering/testing-and-build.md). Renders plain DOM
 * + hand-authored primitives, so jsdom suffices: we assert structure only — the
 * grouped file list, a CSV table preview, the metadata fallback, and the empty /
 * no-projects states — never copy text or shadcn classes.
 */

function renderAnalysis(handlers: FakeHandlers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <ScienceAnalysis />
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
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: 0,
    ...overrides,
  }
}

function listing(files: Array<{ relPath: string; name: string; kind: string }>) {
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
      files: fs.map((f) => ({ ...f, size: 10, mtime: 0 })),
    })),
    total: files.length,
    truncated: false,
  }
}

describe("ScienceAnalysis", () => {
  afterEach(() => setInterfaceLanguage("en"))

  test("shows Analysis guidance in the selected interface language", async () => {
    setInterfaceLanguage("zh-CN")
    renderAnalysis({ "projects.list": () => [] })

    expect(await screen.findByText("浏览和预览项目仓库中的数据文件")).toBeTruthy()
    expect(screen.getByText("没有打开的项目")).toBeTruthy()
  })

  test("creates HTML and marimo reports from the Analysis header", async () => {
    const createTemplate = vi.fn(() => ({ relPath: "reports/report-2.html" }))
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([{ relPath: "reports/report-2.html", name: "report-2.html", kind: "report" }]),
      "science.analysis.createTemplate": createTemplate,
      "science.analysis.openInteractive": () => ({ type: "html", url: "pi-lab-report://test" }),
      "science.analysis.closeInteractive": () => undefined,
    })

    await waitFor(() =>
      expect(screen.getByTestId("analysis-project-select")).toHaveProperty("value", "p1"),
    )
    fireEvent.click(await screen.findByTestId("analysis-new-html-report"))
    await waitFor(() =>
      expect(createTemplate).toHaveBeenCalledWith({ projectId: "p1", kind: "html" }),
    )
    fireEvent.click(screen.getByTestId("analysis-new-marimo-notebook"))
    await waitFor(() =>
      expect(createTemplate).toHaveBeenCalledWith({ projectId: "p1", kind: "marimo" }),
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
    expect(paths).toEqual(["data/metrics.csv", "config.json"])
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

  test("empty search ranks likely results above config-like files within a category", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([
          { relPath: "config.json", name: "config.json", kind: "json" },
          {
            relPath: "runs/experiment-results.json",
            name: "experiment-results.json",
            kind: "json",
          },
        ]),
    })

    await waitFor(() => expect(screen.getAllByTestId("analysis-file")).toHaveLength(2))
    expect(
      screen.getAllByTestId("analysis-file").map((row) => row.getAttribute("data-rel-path")),
    ).toEqual(["runs/experiment-results.json", "config.json"])
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

  test("top-level filter chips are categories, and group headers read by category", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([
          { relPath: "data/metrics.csv", name: "metrics.csv", kind: "csv" },
          { relPath: "runs/loss.npy", name: "loss.npy", kind: "npy" },
          { relPath: "figs/plot.png", name: "plot.png", kind: "image" },
        ]),
    })

    await waitFor(() => {
      expect(screen.getByTestId("analysis-category-filters")).toBeTruthy()
    })
    // csv + npy both collapse into the "Data" category, so there is one Data
    // chip — not separate CSV / NumPy chips.
    expect(screen.getByTestId("analysis-category-data")).toBeTruthy()
    expect(screen.getByTestId("analysis-category-image")).toBeTruthy()
    expect(screen.queryByTestId("analysis-category-csv")).toBeNull()
    expect(screen.queryByTestId("analysis-category-npy")).toBeNull()
    // The grouped list reads by category label, not raw sub-format.
    const filters = screen.getByTestId("analysis-category-filters")
    expect(filters.textContent).toContain("Data")
    expect(filters.textContent).toContain("Images")
    expect(filters.textContent).not.toContain("CSV")
    expect(filters.textContent).not.toContain("NumPy")
  })

  test("selecting a multi-kind category reveals sub-format bubbles that narrow further", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([
          { relPath: "data/metrics.csv", name: "metrics.csv", kind: "csv" },
          { relPath: "runs/loss.npy", name: "loss.npy", kind: "npy" },
        ]),
    })

    await waitFor(() => {
      expect(screen.getAllByTestId("analysis-file")).toHaveLength(2)
    })
    // No sub-bubbles until a category is selected.
    expect(screen.queryByTestId("analysis-subkind-filters")).toBeNull()

    fireEvent.click(screen.getByTestId("analysis-category-data"))

    await waitFor(() => {
      expect(screen.getByTestId("analysis-subkind-filters")).toBeTruthy()
    })
    expect(screen.getByTestId("analysis-subkind-csv")).toBeTruthy()
    expect(screen.getByTestId("analysis-subkind-npy")).toBeTruthy()

    // Narrowing to one sub-kind filters the list to that kind.
    fireEvent.click(screen.getByTestId("analysis-subkind-npy"))
    await waitFor(() => {
      expect(screen.getAllByTestId("analysis-file")).toHaveLength(1)
    })
    expect(screen.getByTestId("analysis-file").getAttribute("data-rel-path")).toBe("runs/loss.npy")
  })

  test("a single-kind category shows no sub-format bubbles", async () => {
    renderAnalysis({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.analysis.listFiles": () =>
        listing([{ relPath: "figs/plot.png", name: "plot.png", kind: "image" }]),
    })

    await waitFor(() => {
      expect(screen.getByTestId("analysis-category-image")).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId("analysis-category-image"))
    // Images is a single-kind category — no second row of bubbles.
    expect(screen.queryByTestId("analysis-subkind-filters")).toBeNull()
  })

  test("the project selector sits in the left column and switches the project", async () => {
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

    const select = (await screen.findByTestId("analysis-project-select")) as HTMLSelectElement
    await waitFor(() => {
      expect(screen.getByTestId("analysis-file").getAttribute("data-rel-path")).toBe("a.csv")
    })

    fireEvent.change(select, { target: { value: "p2" } })
    await waitFor(() => {
      expect(screen.getByTestId("analysis-file").getAttribute("data-rel-path")).toBe("b.json")
    })
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
