import type { Project } from "@skipper/local-db"
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { ScienceAnalysis } from "./ScienceAnalysis"

/**
 * Component test for the Analysis science tab (AGENTS.md §14). Renders plain DOM
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

  test("the search filter narrows the visible rows", async () => {
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

    fireEvent.change(screen.getByTestId("analysis-search"), { target: { value: "metrics" } })

    await waitFor(() => {
      expect(screen.getAllByTestId("analysis-file")).toHaveLength(1)
    })
    expect(screen.getByTestId("analysis-file").getAttribute("data-rel-path")).toBe(
      "data/metrics.csv",
    )
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
