import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"
import { AppProviders } from "../../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../../test/fakeTrpcClient"
import { ExperimentsSection } from "./SettingsSections"

function renderSection() {
  const client = createFakeTrpcClient({})
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
    renderSection()
    const source = screen.getByTestId("settings-experiment-runs-source") as HTMLSelectElement
    expect([...source.options].map((option) => option.textContent)).toEqual(["EXPERIMENTS.md file"])
    expect(source.value).toBe("experiments-md")
    const path = screen.getByTestId("settings-experiment-runs-file") as HTMLInputElement
    expect(path.value).toBe("EXPERIMENTS.md")

    fireEvent.change(path, { target: { value: "notes/runs.md" } })

    expect(window.localStorage.getItem("pi-lab.experiments.runsFile")).toBe("notes/runs.md")
    expect(path.value).toBe("notes/runs.md")
  })
})
