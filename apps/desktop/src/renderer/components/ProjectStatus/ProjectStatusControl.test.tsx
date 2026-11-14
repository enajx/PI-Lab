import { QueryClient } from "@tanstack/react-query"
import { observable } from "@trpc/server/observable"
import { describe, expect, test } from "vitest"
import { AppProviders } from "../../providers/AppProviders"
import { ProjectActivityProvider } from "../../routes/_shell/-ProjectActivity"
import { createFakeTrpcClient, type FakeHandlers } from "../../test/fakeTrpcClient"
import { fireEvent, render, screen, waitFor, within } from "../../test/render"
import { ProjectStatusControl } from "./ProjectStatusControl"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** A stored summary-workflow record as `workflows.status` returns it. */
function summaryRecord(fields: {
  result: string
  lastCheckedAt: number
  errorMessage: string | null
  agentLabel: string | null
  running: boolean
}) {
  return { inputHash: "h", ...fields }
}

/** Render the Project status button through the real providers and a fake IPC client. */
function renderStatus(
  handlers: FakeHandlers,
  props: { lastOpenedAt: number; gitAvailable: boolean },
) {
  const client = createFakeTrpcClient({
    "sessions.onStatus": () => [],
    "sessions.projectAgents": () => [],
    "workflows.status": () => ({
      summary: null,
      fetchExperiments: null,
      planResearch: null,
      latexMerge: null,
    }),
    "workflows.onOutput": () => ({ kind: "start", command: "claude" }),
    "science.tasks.list": () => ({ tasks: [], sources: [] }),
    "science.experiments.status": () => ({ found: false, relPath: "EXPERIMENTS.md" }),
    ...handlers,
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <ProjectActivityProvider>
        <ProjectStatusControl
          projectId="p1"
          projectName="Photon Drift"
          lastOpenedAt={props.lastOpenedAt}
          variant="compact"
          testId="project-status"
          gitAvailable={props.gitAvailable}
          gitDisabledReason="Initialize Git to use this Git-backed action."
        />
      </ProjectActivityProvider>
    </AppProviders>,
  )
}

/** Click the Project status button and return the opened card. */
async function openCard(): Promise<HTMLElement> {
  const button = await screen.findByTestId("project-status")
  expect(button.getAttribute("title")).toBe("Project status")
  expect(button.getAttribute("data-feature-label")).toBe("Project status")
  fireEvent.click(button)
  return screen.findByTestId("project-status-dialog")
}

describe("Project status card", () => {
  test("shows the most recent activity of last opened and agent activity as a relative time", async () => {
    renderStatus(
      {
        "sessions.projectAgents": () => [
          {
            kind: "agent",
            sessionId: "s1",
            agentId: "codex",
            origin: "latex",
            name: "Codex",
            status: "done",
            lastActiveAt: Date.now() - 2 * HOUR,
          },
        ],
      },
      { lastOpenedAt: Date.now() - 3 * DAY, gitAvailable: true },
    )
    const card = await openCard()
    await waitFor(() =>
      expect(within(card).getByTestId("project-status-last-activity").textContent).toContain(
        "2 hours ago",
      ),
    )
  })

  test("shows how many agents are active and how many tasks are open in the project", async () => {
    const live = (sessionId: string, projectId: string, state: "working" | "waiting") => ({
      sessionId,
      projectId,
      projectName: projectId,
      agentId: "codex",
      workspaceId: null,
      origin: "project",
      state,
    })
    const task = (id: string, projectId: string, status: string) => ({ id, projectId, status })
    renderStatus(
      {
        "sessions.onStatus": () =>
          observable((emit) => {
            emit.next([
              live("s1", "p1", "working"),
              live("s2", "p1", "waiting"),
              live("s3", "p2", "working"),
            ])
          }),
        "science.tasks.list": () => ({
          tasks: [
            task("t1", "p1", "backlog"),
            task("t2", "p1", "wip"),
            task("t3", "p1", "planned"),
            task("t4", "p1", "done"),
            task("t5", "p2", "wip"),
          ],
          sources: [],
        }),
      },
      { lastOpenedAt: 0, gitAvailable: true },
    )
    const card = await openCard()
    await waitFor(() =>
      expect(within(card).getByTestId("project-status-active-agents").textContent).toBe(
        "Active agents: 2",
      ),
    )
    await waitFor(() =>
      expect(within(card).getByTestId("project-status-open-tasks").textContent).toBe(
        "Open tasks: 3",
      ),
    )
  })

  test("shows the experiment run counts read from the configured experiments file", async () => {
    window.localStorage.setItem("pi-lab.experiments.runsFile", "notes/runs.md")
    const calls: unknown[] = []
    renderStatus(
      {
        "science.experiments.status": (input) => {
          calls.push(input)
          return {
            found: true,
            relPath: "notes/runs.md",
            running: 1,
            finished: 2,
            failed: 1,
            other: [
              { status: "ABORTED", count: 1 },
              { status: "PLANNED", count: 2 },
            ],
          }
        },
      },
      { lastOpenedAt: 0, gitAvailable: true },
    )
    const card = await openCard()
    await waitFor(() =>
      expect(within(card).getByTestId("project-status-experiment-runs").textContent).toBe(
        "Experiment runs: 1 running, 2 finished, 1 failed; other: 1 ABORTED, 2 PLANNED",
      ),
    )
    expect(calls).toEqual([
      { projectId: "p1", source: { kind: "experiments-md", relPath: "notes/runs.md" } },
    ])
    window.localStorage.clear()
  })

  test("says the experiments file is missing instead of showing zero runs", async () => {
    renderStatus({}, { lastOpenedAt: 0, gitAvailable: true })
    const card = await openCard()
    await waitFor(() =>
      expect(within(card).getByTestId("project-status-experiment-runs").textContent).toBe(
        "Experiment runs: No EXPERIMENTS.md",
      ),
    )
  })

  test("shows the stored project summary with the agent that wrote it and when", async () => {
    renderStatus(
      {
        "workflows.status": () => ({
          summary: summaryRecord({
            result: "Photon drift is **on track**.",
            lastCheckedAt: Date.now() - 3 * DAY,
            errorMessage: null,
            agentLabel: "Claude Code",
            running: false,
          }),
          fetchExperiments: null,
          planResearch: null,
          latexMerge: null,
        }),
      },
      { lastOpenedAt: 0, gitAvailable: true },
    )
    const card = await openCard()
    const summary = await within(card).findByTestId("project-status-summary")
    expect(summary.textContent).toContain("Photon drift is on track.")
    // Rendered as Markdown, not raw asterisks.
    expect(summary.querySelector("strong")?.textContent).toBe("on track")
    expect(within(card).getByTestId("project-status-summary-author").textContent).toBe(
      "Written by Claude Code, 3 days ago",
    )
    expect(within(card).queryByTestId("project-status-no-summary")).toBeNull()
  })

  test("says there is no project summary yet when the summary never ran", async () => {
    renderStatus({}, { lastOpenedAt: 0, gitAvailable: true })
    const card = await openCard()
    expect((await within(card).findByTestId("project-status-no-summary")).textContent).toBe(
      "No project summary yet",
    )
    expect(within(card).getByTestId("project-status-last-activity").textContent).toContain(
      "No activity yet",
    )
  })

  test("shows a failed summary run instead of hiding it", async () => {
    renderStatus(
      {
        "workflows.status": () => ({
          summary: summaryRecord({
            result: "",
            lastCheckedAt: Date.now(),
            errorMessage: "model unavailable",
            agentLabel: null,
            running: false,
          }),
          fetchExperiments: null,
          planResearch: null,
          latexMerge: null,
        }),
      },
      { lastOpenedAt: 0, gitAvailable: true },
    )
    const card = await openCard()
    expect((await within(card).findByTestId("project-status-summary-error")).textContent).toContain(
      "model unavailable",
    )
  })

  test("Generate project summary runs the summary workflow and the card shows the new summary", async () => {
    const calls: unknown[] = []
    let stored: ReturnType<typeof summaryRecord> | null = null
    renderStatus(
      {
        "workflows.status": () => ({
          summary: stored,
          fetchExperiments: null,
          planResearch: null,
          latexMerge: null,
        }),
        "workflows.run": (input) => {
          calls.push(input)
          stored = summaryRecord({
            result: "Fresh summary.",
            lastCheckedAt: Date.now(),
            errorMessage: null,
            agentLabel: "Codex",
            running: false,
          })
          return { cached: false, ...stored }
        },
      },
      { lastOpenedAt: 0, gitAvailable: true },
    )
    const card = await openCard()
    await within(card).findByTestId("project-status-no-summary")
    const update = within(card).getByTestId("project-status-update-summary")
    expect(update.textContent).toContain("Use agent to generate project summary")
    fireEvent.click(update)

    await waitFor(() => expect(calls).toEqual([{ projectId: "p1", task: "summary" }]))
    // The run's live window opens on top, and the status card stays open under it.
    expect(await screen.findByTestId("workflow-result-dialog")).toBeTruthy()
    await waitFor(() =>
      expect(
        within(screen.getByTestId("project-status-dialog")).getByTestId("project-status-summary")
          .textContent,
      ).toContain("Fresh summary."),
    )
    expect(
      within(screen.getByTestId("project-status-dialog")).getByTestId(
        "project-status-summary-author",
      ).textContent,
    ).toBe("Written by Codex, just now")
  })

  test("Generate project summary is disabled with the Git reason when Git is unavailable", async () => {
    renderStatus({}, { lastOpenedAt: 0, gitAvailable: false })
    const card = await openCard()
    const update = within(card).getByTestId("project-status-update-summary")
    expect((update as HTMLButtonElement).disabled).toBe(true)
    expect(update.getAttribute("data-feature-help")).toContain("Initialize Git")
  })

  test("the close button closes the card", async () => {
    renderStatus({}, { lastOpenedAt: 0, gitAvailable: true })
    const card = await openCard()
    fireEvent.click(within(card).getByTestId("project-status-close"))
    await waitFor(() => expect(screen.queryByTestId("project-status-dialog")).toBeNull())
  })
})
