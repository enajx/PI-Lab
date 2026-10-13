import { QueryClient } from "@tanstack/react-query"
import { describe, expect, test } from "vitest"
import { AppProviders } from "../../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../../test/fakeTrpcClient"
import { fireEvent, render, screen, waitFor } from "../../../../test/render"
import { AgentStatusControl } from "./AgentStatusControl"

describe("AgentStatusControl", () => {
  test("shows agent authentication and current sessions when opened", async () => {
    const client = createFakeTrpcClient({
      "setup.environment": () => ({
        harnesses: [
          {
            id: "claude-code",
            label: "Claude Code",
            executable: "claude",
            state: "unauthenticated",
          },
          {
            id: "codex",
            label: "Codex",
            executable: "codex",
            state: "authenticated",
            method: "ChatGPT",
          },
        ],
        github: { executable: "gh", state: "missing", connectivity: "unchecked" },
        zotero: "not-running",
        apiConfigured: { "claude-code": false, codex: false },
      }),
      "sessions.status": () => [
        {
          sessionId: "s1",
          projectId: "p1",
          projectName: "Photon Drift",
          agentId: "codex",
          state: "working",
        },
      ],
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AppProviders client={client} queryClient={queryClient}>
        <AgentStatusControl />
      </AppProviders>,
    )

    const control = screen.getByRole("button", { name: "Agent status" })
    await waitFor(() => expect(control.getAttribute("data-attention")).toBe("true"))
    fireEvent.click(control)
    const panel = screen.getByRole("dialog", { name: "Agent status" })
    expect(panel.textContent).toContain("Claude Code")
    expect(panel.textContent).toContain("Sign in needed")
    expect(panel.textContent).toContain("Codex")
    expect(panel.textContent).toContain("Photon Drift")
    expect(panel.textContent).toContain("Working")
  })
})
