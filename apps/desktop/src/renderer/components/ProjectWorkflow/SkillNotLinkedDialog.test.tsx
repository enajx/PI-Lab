import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { expect, test, vi } from "vitest"
import { AppProviders } from "../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../test/fakeTrpcClient"
import { ProjectWorkflowControl } from "./ProjectWorkflowControl"

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }))

/** Render the Plan research control with a fake client (mocked, not the real IPC boundary). */
function renderPlanResearch(planResearchSkill: string) {
  const run = vi.fn(() => ({ started: true }))
  const handlers: FakeHandlers = {
    "settings.get": () => ({ editor: { planResearchSkill, autoResearchSkill: "" } }),
    "workflows.status": () => ({ summary: null, fetchExperiments: null, planResearch: null }),
    "workflows.run": run,
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AppProviders client={createFakeTrpcClient(handlers)} queryClient={queryClient}>
      <ProjectWorkflowControl
        projectId="p1"
        projectName="Demo"
        task="plan-research"
        variant="labeled"
        testId="plan-research"
      />
    </AppProviders>,
  )
  /** Resolves once the settings query has data, so the control knows the linked skill. */
  const settingsLoaded = () =>
    waitFor(() =>
      expect(
        queryClient
          .getQueryCache()
          .findAll()
          .some((query) => JSON.stringify(query.queryKey).includes("settings") && query.state.data),
      ).toBe(true),
    )
  return { run, settingsLoaded }
}

test("Plan research with no skill linked shows the link popup and starts nothing", async () => {
  const { run, settingsLoaded } = renderPlanResearch("")
  await settingsLoaded()
  fireEvent.click(screen.getByTestId("plan-research"))
  const dialog = await screen.findByTestId("skill-not-linked-dialog")
  expect(dialog.textContent).toContain(
    "Plan research is not linked to a skill yet. Link one in Settings → Agents & worktrees.",
  )
  expect(screen.getByTestId("skill-not-linked-open-settings")).toBeTruthy()
  expect(run).not.toHaveBeenCalled()
})

test("Plan research with a linked skill starts the run", async () => {
  const { run, settingsLoaded } = renderPlanResearch("plan-research")
  await settingsLoaded()
  fireEvent.click(await screen.findByTestId("plan-research"))
  await waitFor(() => expect(run).toHaveBeenCalled())
  expect(screen.queryByTestId("skill-not-linked-dialog")).toBeNull()
})
