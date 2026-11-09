import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { AgentMergeReview } from "./AgentMergeReview"

/**
 * Agent-merge review with a fake (mocked) server. `workflows.run` returns while
 * the agent is still running, as the real router does; the review must wait for
 * the run to finish before reading the merged files.
 */
function renderReview(handlers: FakeHandlers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={createFakeTrpcClient(handlers)} queryClient={queryClient}>
      <AgentMergeReview
        projectId="p1"
        workspaceId="w1"
        files={["main.tex"]}
        pending={false}
        error={null}
        onAccept={() => undefined}
        onReject={() => undefined}
      />
    </AppProviders>,
  )
}

const CONFLICT = "<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> origin\n"
const MERGED = "mine and theirs\n"

function record(running: boolean, lastCheckedAt: number, errorMessage: string | null) {
  return { running, result: "", inputHash: "", lastCheckedAt, errorMessage }
}

describe("AgentMergeReview (mocked server)", () => {
  test("waits for the agent to finish before showing the merged files", async () => {
    let content = CONFLICT
    let polls = 0
    const run = vi.fn(() => ({ cached: false, ...record(true, 0, null) }))
    renderReview({
      "files.read": () => ({ status: "text", exists: true, content, baseline: {} }),
      "workflows.run": run,
      "workflows.status": () => {
        polls += 1
        if (polls < 3) return { latexMerge: record(true, 0, null) }
        content = MERGED
        return { latexMerge: record(false, 5, null) }
      },
    })
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith({ projectId: "p1", task: "latex-merge", force: true }),
    )
    expect(screen.getByRole("status")).toBeTruthy()
    await waitFor(
      () =>
        expect(screen.getByTestId("paper-agent-merge-accept")).toHaveProperty("disabled", false),
      { timeout: 5_000 },
    )
    expect(screen.getByTestId("paper-agent-merge").textContent).toContain("mine and theirs")
  })

  test("shows the agent's error", async () => {
    renderReview({
      "files.read": () => ({ status: "text", exists: true, content: CONFLICT, baseline: {} }),
      "workflows.run": () => ({ cached: false, ...record(true, 0, null) }),
      "workflows.status": () => ({ latexMerge: record(false, 5, "agent exited with code 1") }),
    })
    expect((await screen.findByRole("alert", undefined, { timeout: 5_000 })).textContent).toContain(
      "agent exited with code 1",
    )
  })

  test("Escape does not reject while the agent is still running", async () => {
    const onReject = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AppProviders
        client={createFakeTrpcClient({
          "files.read": () => ({ status: "text", exists: true, content: CONFLICT, baseline: {} }),
          "workflows.run": () => ({ cached: false, ...record(true, 0, null) }),
          "workflows.status": () => ({ latexMerge: record(true, 0, null) }),
        })}
        queryClient={queryClient}
      >
        <AgentMergeReview
          projectId="p1"
          workspaceId="w1"
          files={["main.tex"]}
          pending={false}
          error={null}
          onAccept={() => undefined}
          onReject={onReject}
        />
      </AppProviders>,
    )
    await screen.findByRole("status")
    fireEvent.keyDown(window, { key: "Escape" })
    expect(onReject).not.toHaveBeenCalled()
  })
})
