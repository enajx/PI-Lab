import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { AutomationsView } from "./AutomationsView"

/**
 * Component tests for the Workflows view (docs/testing-and-build.md): jsdom + a fake tRPC
 * client. The view renders plain DOM and the hand-authored UI primitives, so we
 * assert structure and the wiring of the enable toggle / create flow — never
 * copy text or shadcn classes.
 */

function renderView(handlers: FakeHandlers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <AutomationsView />
    </AppProviders>,
  )
}

function automation(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    name: "Nightly",
    agentId: "claude-code",
    projectId: "p1",
    recurrenceRule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    scheduleSummary: "Daily at 9:00 AM",
    timezone: "UTC",
    enabled: true,
    nextRunAt: Date.now() + 3_600_000,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

const baseHandlers: FakeHandlers = {
  "projects.list": () => [{ id: "p1", name: "Repo", repoPath: "/tmp/repo" }],
  "agents.list": () => [{ id: "claude-code", label: "Claude Code" }],
  "automations.listRuns": () => [],
}

describe("AutomationsView", () => {
  test("renders the empty state when there are no automations", async () => {
    renderView({ ...baseHandlers, "automations.list": () => [] })
    await waitFor(() => {
      expect(screen.getByTestId("automations-empty")).toBeTruthy()
    })
  })

  test("renders a row per automation with its schedule summary and next run", async () => {
    renderView({
      ...baseHandlers,
      "automations.list": () => [
        automation({ id: "a1", name: "Nightly" }),
        automation({ id: "a2", name: "Hourly sweep", scheduleSummary: "Hourly" }),
      ],
    })

    await waitFor(() => {
      expect(screen.getAllByTestId("automation-row")).toHaveLength(2)
    })
    const names = screen.getAllByTestId("automation-name").map((el) => el.textContent)
    expect(names).toEqual(["Nightly", "Hourly sweep"])
    const summaries = screen.getAllByTestId("schedule-summary").map((el) => el.textContent)
    expect(summaries).toEqual(["Daily at 9:00 AM", "Hourly"])
  })

  test("the enable toggle calls setEnabled with the inverted state", async () => {
    const setEnabled = vi.fn(() => ({ ...automation(), enabled: false }))
    renderView({
      ...baseHandlers,
      "automations.list": () => [automation({ enabled: true })],
      "automations.setEnabled": setEnabled,
    })

    await waitFor(() => {
      expect(screen.getByTestId("enabled-checkbox")).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId("enabled-checkbox"))

    await waitFor(() => {
      expect(setEnabled).toHaveBeenCalledWith({ id: "a1", enabled: false })
    })
  })

  test("run-now fires the runNow mutation", async () => {
    const runNow = vi.fn(() => ({ runId: "r1" }))
    renderView({
      ...baseHandlers,
      "automations.list": () => [automation()],
      "automations.runNow": runNow,
    })

    await waitFor(() => {
      expect(screen.getByTestId("run-now")).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId("run-now"))
    await waitFor(() => {
      expect(runNow).toHaveBeenCalledWith({ id: "a1" })
    })
  })

  test("the New workflow button reveals the create form", async () => {
    renderView({
      ...baseHandlers,
      "automations.list": () => [],
      "automations.previewSchedule": () => ({ valid: true, summary: "Daily", upcoming: [] }),
    })
    // Wait until projects + agents have loaded so the create button is enabled.
    await waitFor(() => {
      expect((screen.getByTestId("new-automation") as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(screen.getByTestId("new-automation"))
    await waitFor(() => {
      expect(screen.getByTestId("create-automation-form")).toBeTruthy()
    })
  })
})
