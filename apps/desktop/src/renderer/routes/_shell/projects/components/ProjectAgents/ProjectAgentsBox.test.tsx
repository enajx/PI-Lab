import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import type { ProjectAgentRow } from "../../../../../../shared/projectAgents"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"

/**
 * Component tests for the Project view's "Project Agents" box. The tRPC server
 * and the router are fakes (mocked); the e2e test covers the real app.
 */
const mocks = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }))

const { ProjectAgentsBox, formatLastActive } = await import("./ProjectAgentsBox")

const HOUR = 3_600_000

function renderBox(rows: ProjectAgentRow[], extra: FakeHandlers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({ "sessions.projectAgents": () => rows, ...extra })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <ProjectAgentsBox projectId="p1" projectName="Project" className="" />
    </AppProviders>,
  )
}

describe("ProjectAgentsBox (mocked server)", () => {
  test("is hidden when the project has no agents outside the Project view", async () => {
    const projectAgents = vi.fn(() => [])
    renderBox([], { "sessions.projectAgents": projectAgents })
    await waitFor(() => expect(projectAgents).toHaveBeenCalled())
    expect(screen.queryByTestId("project-agents-box")).toBeNull()
  })

  test("lists each agent with its origin, name, status and last activity, and opens it in its view", async () => {
    const now = Date.now()
    renderBox(
      [
        {
          kind: "agent",
          sessionId: "s1",
          agentId: "claude-code",
          origin: "latex",
          name: "Claude Code",
          status: "working",
          lastActiveAt: now,
        },
        {
          kind: "agent",
          sessionId: "s2",
          agentId: "codex",
          origin: "latex",
          name: "Codex",
          status: "waiting",
          lastActiveAt: now - 2 * HOUR,
        },
        { kind: "background", task: "plan-research", status: "working", lastActiveAt: now },
      ],
      {},
    )
    const rows = await screen.findAllByTestId("project-agent-row")
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/Claude Code.*working.*now/),
      expect.stringMatching(/Codex.*waiting for input.*2h ago/),
      expect.stringMatching(/Plan research.*working.*now/),
    ])
    expect(within(rows[0] as HTMLElement).getByTestId("latex-logo")).toBeTruthy()
    expect(rows[2]?.getAttribute("data-origin")).toBe("background")

    fireEvent.click(rows[1] as HTMLElement)
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/science/latex",
      search: { projectId: "p1", sessionId: "s2", agentId: "codex", agentLabel: "Codex" },
    })
  })

  test("a background run opens its routine result window", async () => {
    renderBox([{ kind: "background", task: "plan-research", status: "working", lastActiveAt: 1 }], {
      "workflows.status": () => ({
        latexMerge: null,
        summary: null,
        fetchExperiments: null,
        planResearch: {
          running: true,
          result: "",
          inputHash: "",
          lastCheckedAt: 0,
          errorMessage: null,
        },
      }),
      "workflows.onOutput": () => undefined,
    })
    fireEvent.click(await screen.findByTestId("project-agent-row"))
    expect(await screen.findByRole("dialog")).toBeTruthy()
  })
})

describe("formatLastActive", () => {
  test("reads now, minutes, hours and days", () => {
    const now = 10 * 24 * HOUR
    expect(formatLastActive(now - 20_000, now)).toBe("now")
    expect(formatLastActive(now - 5 * 60_000, now)).toBe("5m ago")
    expect(formatLastActive(now - 2 * HOUR, now)).toBe("2h ago")
    expect(formatLastActive(now - 24 * HOUR, now)).toBe("1 day ago")
    expect(formatLastActive(now - 7 * 24 * HOUR, now)).toBe("7 days ago")
  })
})
