import { useQuery } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { expect, test, vi } from "vitest"
import { createFakeTrpcClient } from "../../test/fakeTrpcClient"
import { useTRPC } from "../../trpc/react"
import { AppProviders } from "./AppProviders"

function QueryProbe() {
  const trpc = useTRPC()
  const query = useQuery(trpc.health.ping.queryOptions({ message: "hello" }))
  return (
    <span data-testid="probe">{query.isError ? "error" : (query.data?.echo ?? "loading")}</span>
  )
}

test("the app query client keeps a successful read fresh across a quick remount", async () => {
  const ping = vi.fn(() => ({ echo: "ready" }))
  const client = createFakeTrpcClient({ "health.ping": ping })
  function Screen() {
    const [show, setShow] = useState(true)
    return (
      <>
        {show ? <QueryProbe /> : null}
        <button type="button" onClick={() => setShow((value) => !value)}>
          Toggle
        </button>
      </>
    )
  }
  render(
    <AppProviders client={client}>
      <Screen />
    </AppProviders>,
  )
  await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready"))
  fireEvent.click(screen.getByText("Toggle"))
  fireEvent.click(screen.getByText("Toggle"))
  expect(screen.getByTestId("probe").textContent).toBe("ready")
  expect(ping).toHaveBeenCalledTimes(1)
})

test("a deterministic query error surfaces after one attempt", async () => {
  const ping = vi.fn(() => {
    throw new Error("offline")
  })
  const client = createFakeTrpcClient({ "health.ping": ping })
  render(
    <AppProviders client={client}>
      <QueryProbe />
    </AppProviders>,
  )
  await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("error"))
  expect(ping).toHaveBeenCalledTimes(1)
})
