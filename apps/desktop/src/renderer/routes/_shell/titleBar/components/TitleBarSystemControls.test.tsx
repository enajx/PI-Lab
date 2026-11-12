import { QueryClient } from "@tanstack/react-query"
import { describe, expect, test } from "vitest"
import { AppProviders } from "../../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../../test/fakeTrpcClient"
import { render, screen } from "../../../../test/render"
import { ProjectActivityProvider } from "../../-ProjectActivity"
import { TitleBarSystemControls } from "./TitleBarSystemControls"

describe("TitleBarSystemControls", () => {
  test("agents and caffeine buttons are 7 units tall like the other top bar buttons, after a divider", () => {
    const client = createFakeTrpcClient({
      "setup.environment": () => ({
        harnesses: [],
        github: { executable: "gh", state: "missing", connectivity: "unchecked" },
        zotero: "not-running",
        apiConfigured: {},
      }),
      "sessions.onStatus": () => [],
      "caffeine.status": () => ({ mode: "off", held: false }),
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AppProviders client={client} queryClient={queryClient}>
        <ProjectActivityProvider>
          <TitleBarSystemControls />
        </ProjectActivityProvider>
      </AppProviders>,
    )
    const agents = screen.getByTestId("agent-status-control")
    const caffeine = screen.getByTestId("caffeine-control")
    const divider = screen.getByTestId("title-bar-controls-divider")
    expect(agents.className).toMatch(/\bh-7\b/)
    expect(agents.className).toMatch(/\bw-7\b/)
    expect(caffeine.className).toMatch(/\bh-7\b/)
    expect(caffeine.className).not.toMatch(/\bh-8\b/)
    expect(divider.className).toMatch(/\bw-px\b/)
    expect(divider.className).toMatch(/\bh-4\b/)
    // With no view buttons before it (an empty Dashboard top bar), the divider is hidden.
    expect(divider.className).toMatch(/(^|\s)first:hidden(\s|$)/)
    expect(divider.compareDocumentPosition(agents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
