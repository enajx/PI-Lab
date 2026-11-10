import type { ProjectStage } from "@pi-lab/local-db"
import { QueryClient, useQuery } from "@tanstack/react-query"
import { describe, expect, test } from "vitest"
import { AppProviders } from "../../providers/AppProviders"
import { FeatureHelpPanel } from "../../routes/_shell/components/Sidebar/Sidebar"
import { createFakeTrpcClient } from "../../test/fakeTrpcClient"
import { fireEvent, render, screen, waitFor } from "../../test/render"
import { useTRPC } from "../../trpc/react"
import { ProjectStageRow } from "./ProjectStageRow"

/** Show the stage row from the project query, as the project view and card do. */
function StageFromQuery() {
  const trpc = useTRPC()
  const project = useQuery(trpc.projects.get.queryOptions({ id: "p1" }))
  if (!project.data) return null
  return (
    <ProjectStageRow
      projectId="p1"
      stage={project.data.metadata?.stage ?? null}
      testId="stage"
      className=""
    />
  )
}

/** Render the row over a fake IPC client that stores the stage like the main process. */
function renderStage(initial: ProjectStage | null) {
  const state: { stage: ProjectStage | null; calls: unknown[] } = { stage: initial, calls: [] }
  const client = createFakeTrpcClient({
    "projects.get": () => ({
      id: "p1",
      name: "Photon Drift",
      metadata: state.stage === null ? null : { stage: state.stage },
    }),
    "projects.setStage": (input) => {
      const { stage } = input as { stage: ProjectStage | null }
      state.calls.push(input)
      state.stage = stage
      return { id: "p1" }
    },
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <StageFromQuery />
    </AppProviders>,
  )
  return state
}

/** The filled and current flags of each step, in order. */
function stepStates() {
  return ["planning", "experiments", "paperWriting", "submitted"].map((id) => {
    const step = screen.getByTestId(`stage-step-${id}`)
    return `${step.dataset.filled === "true" ? "filled" : "empty"}${step.getAttribute("aria-current") === "step" ? ",current" : ""}`
  })
}

describe("Project stage row", () => {
  test("a new project has no step filled; the row is named Project status and each step has its own name", async () => {
    renderStage(null)
    const planning = await screen.findByTestId("stage-step-planning")
    expect(stepStates()).toEqual(["empty", "empty", "empty", "empty"])
    expect(screen.getByTestId("stage").getAttribute("title")).toBe("Project status")
    expect(planning.getAttribute("title")).toBe("Planning")
    expect(planning.getAttribute("aria-label")).toBe("Planning step")
    expect(screen.getByTestId("stage-step-paperWriting").getAttribute("aria-label")).toBe(
      "Paper writing step",
    )
  })

  test("reached steps and the lines between them are filled, and the stage is marked current", async () => {
    renderStage("paperWriting")
    await screen.findByTestId("stage-step-planning")
    expect(stepStates()).toEqual(["filled", "filled", "filled,current", "empty"])
    expect(screen.getByTestId("stage-step-paperWriting").getAttribute("aria-label")).toBe(
      "Paper writing step (current)",
    )
    const lines = screen.getAllByTestId("stage-line").map((line) => line.dataset.filled)
    expect(lines).toEqual(["true", "true", "false"])
  })

  test("hovering a step names that step, what a click does, and the current stage", async () => {
    const state = renderStage(null)
    render(<FeatureHelpPanel onHide={() => {}} />)
    const experiments = await screen.findByTestId("stage-step-experiments")
    expect(experiments.getAttribute("title")).toBe("Experiments")
    fireEvent.pointerOver(experiments)
    expect(screen.getByTestId("sidebar-feature-help-label").textContent).toBe("Project status")
    expect(screen.getByTestId("sidebar-feature-help-description").textContent).toBe(
      "Experiments: click to set. Not started yet.",
    )
    fireEvent.click(screen.getByTestId("stage-step-experiments"))
    await waitFor(() => expect(state.stage).toBe("experiments"))
    await waitFor(() =>
      expect(screen.getByTestId("stage-step-planning").dataset.filled).toBe("true"),
    )
    fireEvent.pointerOver(screen.getByTestId("stage-step-paperWriting"))
    expect(screen.getByTestId("sidebar-feature-help-label").textContent).toBe("Project status")
    expect(screen.getByTestId("sidebar-feature-help-description").textContent).toBe(
      "Paper writing: click to set. Current: Experiments.",
    )
    fireEvent.pointerOver(screen.getByTestId("stage-step-experiments"))
    expect(screen.getByTestId("sidebar-feature-help-description").textContent).toBe(
      "Experiments: the current stage. Click to go back to Planning.",
    )
  })

  test("clicking a step sets the stage and saves it", async () => {
    const state = renderStage(null)
    fireEvent.click(await screen.findByTestId("stage-step-experiments"))
    await waitFor(() =>
      expect(stepStates()).toEqual(["filled", "filled,current", "empty", "empty"]),
    )
    expect(state.calls).toEqual([{ id: "p1", stage: "experiments" }])
  })

  test("a double-click sets the stage once", async () => {
    const state = renderStage(null)
    const experiments = await screen.findByTestId("stage-step-experiments")
    fireEvent.click(experiments)
    fireEvent.doubleClick(experiments)
    await waitFor(() => expect(state.calls).toEqual([{ id: "p1", stage: "experiments" }]))
  })

  test("clicking the current step moves back one step, down to no stage", async () => {
    const state = renderStage("experiments")
    fireEvent.click(await screen.findByTestId("stage-step-experiments"))
    await waitFor(() => expect(stepStates()).toEqual(["filled,current", "empty", "empty", "empty"]))
    fireEvent.click(screen.getByTestId("stage-step-planning"))
    await waitFor(() => expect(stepStates()).toEqual(["empty", "empty", "empty", "empty"]))
    expect(state.calls).toEqual([
      { id: "p1", stage: "planning" },
      { id: "p1", stage: null },
    ])
  })

  // jsdom does not turn Enter or Space on a button into a click as a browser does, so
  // this checks the steps are focusable buttons, which gives them that behaviour.
  test("steps are focusable buttons, so Enter and Space set them", async () => {
    renderStage(null)
    const submitted = await screen.findByTestId("stage-step-submitted")
    expect(submitted.tagName).toBe("BUTTON")
    expect(submitted.getAttribute("type")).toBe("button")
    submitted.focus()
    expect(document.activeElement).toBe(submitted)
  })

  test("a failed save is shown", async () => {
    const client = createFakeTrpcClient({
      "projects.setStage": () => Promise.reject(new Error("Database is locked")),
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AppProviders client={client} queryClient={queryClient}>
        <ProjectStageRow projectId="p1" stage={null} testId="stage" className="" />
      </AppProviders>,
    )
    fireEvent.click(screen.getByTestId("stage-step-planning"))
    expect((await screen.findByRole("alert")).textContent).toContain("Database is locked")
  })
})
