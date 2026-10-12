import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { expect, test } from "vitest"
import { AppProviders } from "../../providers/AppProviders"
import { createFakeTrpcClient } from "../../test/fakeTrpcClient"
import { ProjectActivityProvider, useProjectActivityState } from "./-ProjectActivity"

function Status({ projectId }: { projectId: string }) {
  const state = useProjectActivityState(projectId)
  return <span data-testid={`status-${projectId}`}>{state}</span>
}

test("one shell owner keeps card and sidebar status current across dashboard unmount", async () => {
  let calls = 0
  let activity: Array<{ projectId: string; state: "waiting" | "working" | "exited" }> = [
    { projectId: "a", state: "working" },
    { projectId: "a", state: "waiting" },
    { projectId: "b", state: "exited" },
  ]
  const client = createFakeTrpcClient({
    "sessions.activity": () => {
      calls += 1
      return activity
    },
  })

  function Shell() {
    const [showDashboard, setShowDashboard] = useState(true)
    return (
      <ProjectActivityProvider>
        <Status projectId="a" />
        <Status projectId="b" />
        {showDashboard ? <Status projectId="a" /> : null}
        <button type="button" onClick={() => setShowDashboard(false)}>
          Leave dashboard
        </button>
      </ProjectActivityProvider>
    )
  }

  render(
    <AppProviders
      client={client}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Shell />
    </AppProviders>,
  )
  await waitFor(() => expect(screen.getAllByTestId("status-a")[0]?.textContent).toBe("attention"))
  expect(screen.getByTestId("status-b").textContent).toBe("idle")
  expect(calls).toBe(1)

  fireEvent.click(screen.getByRole("button", { name: "Leave dashboard" }))
  activity = [{ projectId: "a", state: "working" }]
  await waitFor(() => expect(screen.getByTestId("status-a").textContent).toBe("active"), {
    timeout: 2_500,
  })
  expect(calls).toBeGreaterThan(1)
})
