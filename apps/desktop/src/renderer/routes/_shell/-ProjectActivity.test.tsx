import { QueryClient } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { type Observer, observable } from "@trpc/server/observable"
import { useState } from "react"
import { expect, test, vi } from "vitest"
import type { LiveAgentStatus } from "../../../shared/agentStatus"
import { AppProviders } from "../../providers/AppProviders"
import { createFakeTrpcClient } from "../../test/fakeTrpcClient"
import {
  ProjectActivityProvider,
  useAgentStatus,
  useProjectActivityState,
} from "./-ProjectActivity"

function Status({ projectId }: { projectId: string }) {
  const state = useProjectActivityState(projectId)
  return <span data-testid={`status-${projectId}`}>{state}</span>
}

test("one shell subscription keeps cards and sidebar current across dashboard unmount", async () => {
  let calls = 0
  const stop = vi.fn()
  let emit: Observer<LiveAgentStatus[], unknown> | undefined
  const row = { sessionId: "s1", projectId: "a", projectName: "Alpha", agentId: "codex" }
  const client = createFakeTrpcClient({
    "sessions.onStatus": () =>
      observable<LiveAgentStatus[]>((observer) => {
        calls += 1
        emit = observer
        observer.next([{ ...row, state: "waiting" }])
        return () => {
          stop()
          emit = undefined
        }
      }),
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

  const view = render(
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
  act(() => emit?.next([{ ...row, state: "working" }]))
  await waitFor(() => expect(screen.getByTestId("status-a").textContent).toBe("active"))
  expect(calls).toBe(1)
  view.unmount()
  expect(stop).toHaveBeenCalledOnce()
  expect(emit).toBeUndefined()
})

test("a subscription error keeps the last activity snapshot and exposes the error", async () => {
  let emit: Observer<LiveAgentStatus[], unknown> | undefined
  const client = createFakeTrpcClient({
    "sessions.onStatus": () =>
      observable<LiveAgentStatus[]>((observer) => {
        emit = observer
        observer.next([
          {
            sessionId: "s1",
            projectId: "a",
            projectName: "Alpha",
            agentId: "codex",
            state: "working",
          },
        ])
        return () => {}
      }),
  })
  function ReadStatus() {
    const snapshot = useAgentStatus()
    return (
      <>
        <Status projectId="a" />
        <span role="alert">{snapshot.error?.message}</span>
      </>
    )
  }
  render(
    <AppProviders client={client}>
      <ProjectActivityProvider>
        <ReadStatus />
      </ProjectActivityProvider>
    </AppProviders>,
  )
  await waitFor(() => expect(screen.getByTestId("status-a").textContent).toBe("active"))
  act(() => emit?.error(new Error("activity connection lost")))
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("activity connection lost"),
  )
  expect(screen.getByTestId("status-a").textContent).toBe("active")
})
