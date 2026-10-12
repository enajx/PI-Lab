import { QueryClient } from "@tanstack/react-query"
import { describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../test/fakeTrpcClient"
// StrictMode-wrapped render (see test/render.tsx): reproduces the dev build's
// effect double-invoke so the subscription mount effect runs as it does live.
import { fireEvent, render, screen, waitFor, within } from "../../test/render"
import { WorkflowResultDialog } from "./WorkflowResultDialog"

/**
 * Component test for the workflow result window: it must (1) render the printed
 * report as MARKDOWN (not raw `**bold**`), (2) stream the run's live output into
 * the activity log via `workflows.onOutput`, and (3) show the correct state for
 * running / done / error — never a silent blank.
 */

function renderDialog(
  props: Partial<Parameters<typeof WorkflowResultDialog>[0]>,
  handlers: FakeHandlers = {},
) {
  const onClose = props.onClose ?? vi.fn()
  const onRecheck = props.onRecheck ?? vi.fn(() => Promise.resolve())
  const client = createFakeTrpcClient({
    // Default: no live output for this run.
    "workflows.onOutput": () => ({ kind: "start", command: "" }),
    ...handlers,
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <WorkflowResultDialog
        projectId="p1"
        task="summary"
        title="Project summary"
        reportHeading="Project status"
        projectName="Photon Drift"
        running={false}
        result=""
        errorMessage={null}
        lastCheckedAt={Date.now() - 60_000}
        guidance="Check RESEARCH.md for the updated status."
        onRecheck={onRecheck}
        onClose={onClose}
        {...props}
      />
    </AppProviders>,
  )
  return { onClose, onRecheck }
}

describe("WorkflowResultDialog", () => {
  test("renders at the document root so card hover effects cannot contain or clip it", async () => {
    renderDialog({})

    const backdrop = await screen.findByTestId("workflow-result-backdrop")
    expect(backdrop.parentElement).toBe(document.body)
  })

  test("renders the printed report as markdown, not raw syntax", async () => {
    renderDialog({ result: "# Photon status\n\nDrift is **under control** now." })

    const report = await screen.findByTestId("workflow-result-text")
    // The heading and bold became real elements…
    expect(report.querySelector("h1")?.textContent).toContain("Photon status")
    expect(report.querySelector("strong")?.textContent).toBe("under control")
    // …and the raw markdown markers are gone.
    expect(report.textContent).not.toContain("**")
    expect(report.textContent).not.toContain("# Photon")
  })

  test("streams the run's live activity steps into the activity log", async () => {
    // The server now streams readable step lines (e.g. "→ Read train.py"), which
    // are distinct from the final report — the window just renders them live.
    renderDialog(
      { running: true },
      {
        "workflows.onOutput": () => ({
          kind: "chunk",
          stream: "stdout",
          text: "→ Read train.py\n",
        }),
      },
    )

    const log = await screen.findByTestId("workflow-activity-log")
    await waitFor(() => expect(log.textContent).toContain("→ Read train.py"))
  })

  test("Recheck button forces a fresh run and re-subscribes to its live stream", async () => {
    // A done run: the report shows, and Recheck is enabled. Clicking it invokes
    // onRecheck (the control wires this to workflows.run with force) and streams
    // the new run's steps into the log.
    let subscribeCount = 0
    const { onRecheck } = renderDialog(
      { running: false, result: "First summary." },
      {
        "workflows.onOutput": () => {
          subscribeCount += 1
          return {
            kind: "chunk",
            stream: "stdout",
            text: `→ Edit RESEARCH.md (run ${subscribeCount})\n`,
          }
        },
      },
    )

    const recheck = await screen.findByTestId("workflow-result-recheck")
    expect((recheck as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(recheck)
    await waitFor(() => expect(onRecheck).toHaveBeenCalledTimes(1))

    // The subscription re-attaches for the forced run (nonce bump) → the log shows
    // the new run's streamed step.
    const log = await screen.findByTestId("workflow-activity-log")
    await waitFor(() => expect(log.textContent).toContain("→ Edit RESEARCH.md"))
  })

  test("Recheck is disabled while a run is in flight", async () => {
    renderDialog({ running: true })
    const recheck = await screen.findByTestId("workflow-result-recheck")
    expect((recheck as HTMLButtonElement).disabled).toBe(true)
  })

  test("shows the command/agent line from the run's start event", async () => {
    renderDialog(
      { running: true },
      { "workflows.onOutput": () => ({ kind: "start", command: "Codex · /usr/bin/codex" }) },
    )

    const command = await screen.findByTestId("workflow-activity-command")
    expect(command.textContent).toContain("Codex · /usr/bin/codex")
  })

  test("shows a working state and hides the report while running", async () => {
    renderDialog({ running: true, result: "" })

    expect(await screen.findByTestId("workflow-result-working")).toBeTruthy()
    expect(screen.queryByTestId("workflow-result-text")).toBeNull()
    // The last-checked line is meaningless mid-run, so it is hidden.
    expect(screen.queryByTestId("workflow-result-last-checked")).toBeNull()
  })

  test("done state renders the markdown report plus the last-checked line", async () => {
    renderDialog({ running: false, result: "All **green**." })

    const report = await screen.findByTestId("workflow-result-text")
    expect(report.querySelector("strong")?.textContent).toBe("green")
    expect(screen.getByTestId("workflow-result-last-checked").textContent).toContain(
      "Last checked:",
    )
    expect(screen.getByTestId("workflow-result-guidance").textContent).toContain("RESEARCH.md")
    expect(screen.queryByTestId("workflow-result-working")).toBeNull()
  })

  test("error state surfaces the failure and shows no report (no silent failure)", async () => {
    renderDialog({ running: false, errorMessage: "Codex is not available" })

    expect((await screen.findByTestId("workflow-result-error")).textContent).toContain(
      "Codex is not available",
    )
    expect(screen.queryByTestId("workflow-result-text")).toBeNull()
    expect(screen.queryByTestId("workflow-result-working")).toBeNull()
  })

  test("survives a missing/failed subscription — the report still renders", async () => {
    // No handler for workflows.onOutput → the fake client errors the subscription.
    renderDialog(
      { running: false, result: "Steady progress." },
      { "workflows.onOutput": undefined as unknown as FakeHandlers[string] },
    )

    const report = await screen.findByTestId("workflow-result-text")
    expect(report.textContent).toContain("Steady progress.")
    // The activity log falls back to its empty state rather than crashing.
    expect(within(await screen.findByTestId("workflow-activity-log")).queryByText(/./)).toBeTruthy()
  })
})
