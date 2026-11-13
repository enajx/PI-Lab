import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../test/fakeTrpcClient"
import { ExperimentsSection } from "./SettingsSections"

function renderSection(handlers: FakeHandlers) {
  const client = createFakeTrpcClient(handlers)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <ExperimentsSection />
    </AppProviders>,
  )
}

describe("Settings > Remote experiments: where runs are tracked", () => {
  afterEach(() => window.localStorage.clear())

  test("offers the EXPERIMENTS.md file as the runs source, with its path relative to the project", () => {
    renderSection({})
    const source = screen.getByTestId("settings-experiment-runs-source") as HTMLSelectElement
    expect([...source.options].map((option) => option.textContent)).toEqual(["EXPERIMENTS.md file"])
    expect(source.value).toBe("experiments-md")
    const path = screen.getByTestId("settings-experiment-runs-file") as HTMLInputElement
    expect(path.value).toBe("EXPERIMENTS.md")

    fireEvent.change(path, { target: { value: "notes/runs.md" } })

    expect(window.localStorage.getItem("pi-lab.experiments.runsFile")).toBe("notes/runs.md")
    expect(path.value).toBe("notes/runs.md")
  })

  test("hides the Analysis folder tree (off by default), the same choice as the toggle in Analysis", () => {
    renderSection({})
    const toggle = screen.getByTestId("settings-analysis-flat-list")
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(toggle)
    expect(window.localStorage.getItem("pi-lab.analysis.flatList")).toBe("true")
    expect(toggle.getAttribute("aria-checked")).toBe("true")
  })

  test("sets the default results folder that Analysis lists, relative to each project", () => {
    renderSection({})
    const folder = screen.getByTestId("settings-results-folder") as HTMLInputElement
    expect(folder.value).toBe("results")

    fireEvent.change(folder, { target: { value: "outputs/runs" } })

    expect(window.localStorage.getItem("pi-lab.experiments.resultsFolder")).toBe("outputs/runs")
    expect(folder.value).toBe("outputs/runs")
  })

  test("sets the default experiments folder structure, saved in the YAML file it names", async () => {
    let defaultValue = "auto"
    const setStructure = vi.fn((input: unknown) => {
      defaultValue = (input as { value: string }).value
      return { filePath: "/data/experiments-structure.yaml", defaultValue, projectValue: null }
    })
    renderSection({
      "science.analysis.getStructure": () => ({
        filePath: "/data/experiments-structure.yaml",
        defaultValue,
        projectValue: null,
      }),
      "science.analysis.setStructure": setStructure,
    })
    const select = (await screen.findByTestId(
      "settings-experiments-structure",
    )) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe("auto"))
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Auto-detect",
      "One folder per experiment",
      "Experiment / run folders",
      "Flat file list",
      "Custom pattern",
    ])
    expect(screen.getByTestId("settings-experiments-structure-file").textContent).toContain(
      "/data/experiments-structure.yaml",
    )
    fireEvent.change(select, { target: { value: "flat" } })
    await waitFor(() =>
      expect(setStructure).toHaveBeenCalledWith({ projectId: null, value: "flat" }),
    )
    await waitFor(() => expect(select.value).toBe("flat"))
  })

  test("an invalid structure file shows its error instead of a choice", async () => {
    const message =
      'Invalid experiments structure file /data/x.yaml: Unknown experiments structure "nested".'
    renderSection({
      "science.analysis.getStructure": () => {
        throw new Error(message)
      },
    })
    expect((await screen.findByTestId("settings-experiments-structure-error")).textContent).toBe(
      message,
    )
  })
})
