import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
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
  return renderReviewWith(handlers, () => undefined)
}

/** {@link renderReview} with an Accept callback. `paper.conflicts` defaults to main.tex (text). */
function renderReviewWith(handlers: FakeHandlers, onAccept: () => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders
      client={createFakeTrpcClient({
        "paper.conflicts": () => [{ relPath: "main.tex", kind: "text" }],
        ...handlers,
      })}
      queryClient={queryClient}
    >
      <AgentMergeReview
        projectId="p1"
        workspaceId="w1"
        pending={false}
        error={null}
        onAccept={onAccept}
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
          "paper.conflicts": () => [{ relPath: "main.tex", kind: "text" }],
          "files.read": () => ({ status: "text", exists: true, content: CONFLICT, baseline: {} }),
          "workflows.run": () => ({ cached: false, ...record(true, 0, null) }),
          "workflows.status": () => ({ latexMerge: record(true, 0, null) }),
        })}
        queryClient={queryClient}
      >
        <AgentMergeReview
          projectId="p1"
          workspaceId="w1"
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

  test("a figure and a deleted file get Keep mine / Keep Overleaf; only text goes to the agent", async () => {
    const reads: unknown[] = []
    const resolveFile = vi.fn(() => [])
    const onAccept = vi.fn()
    let content = CONFLICT
    renderReviewWith(
      {
        "paper.conflicts": () => [
          { relPath: "figures/plot.png", kind: "binary" },
          { relPath: "main.tex", kind: "text" },
          { relPath: "refs.bib", kind: "deleted-overleaf" },
        ],
        "files.read": (input) => {
          reads.push(input)
          return { status: "text", exists: true, content, baseline: {} }
        },
        "workflows.run": () => {
          content = MERGED
          return { cached: false, ...record(false, 5, null) }
        },
        "paper.resolveFile": resolveFile,
      },
      onAccept,
    )
    const figure = await screen.findByTestId("paper-agent-merge-file-figures/plot.png", undefined, {
      timeout: 5_000,
    })
    expect(reads).toEqual([
      { workspaceId: "w1", relPath: "main.tex" },
      { workspaceId: "w1", relPath: "main.tex" },
    ])
    const accept = screen.getByTestId("paper-agent-merge-accept")
    expect(accept).toHaveProperty("disabled", true)
    fireEvent.click(within(figure).getByRole("button", { name: "Keep Overleaf" }))
    expect(accept).toHaveProperty("disabled", true)
    const deleted = screen.getByTestId("paper-agent-merge-file-refs.bib")
    expect(deleted.textContent).toContain("Deleted on Overleaf, changed here")
    fireEvent.click(within(deleted).getByRole("button", { name: "Keep mine" }))
    expect(accept).toHaveProperty("disabled", false)
    // Nothing is settled before Accept, so Reject leaves every file in conflict.
    expect(resolveFile).not.toHaveBeenCalled()
    fireEvent.click(accept)
    await waitFor(() => expect(onAccept).toHaveBeenCalled())
    expect(resolveFile).toHaveBeenCalledWith({
      projectId: "p1",
      relPath: "figures/plot.png",
      choice: "overleaf",
    })
    expect(resolveFile).toHaveBeenCalledWith({
      projectId: "p1",
      relPath: "refs.bib",
      choice: "mine",
    })
  })

  test("with no text file in conflict, the agent is not run", async () => {
    const run = vi.fn()
    renderReview({
      "paper.conflicts": () => [{ relPath: "figures/plot.png", kind: "binary" }],
      "workflows.run": run,
    })
    expect(await screen.findByTestId("paper-agent-merge-file-figures/plot.png")).toBeTruthy()
    expect(run).not.toHaveBeenCalled()
  })

  test("a run with no status record is shown as failed instead of waiting forever", async () => {
    renderReview({
      "files.read": () => ({ status: "text", exists: true, content: CONFLICT, baseline: {} }),
      "workflows.run": () => ({ cached: false, ...record(true, 0, null) }),
      "workflows.status": () => ({ latexMerge: null }),
    })
    expect((await screen.findByRole("alert", undefined, { timeout: 5_000 })).textContent).toContain(
      "The merge agent stopped without a result",
    )
  })
})
