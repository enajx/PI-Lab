import { QueryClient } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import { expect, test } from "vitest"
import { AppProviders } from "../providers/AppProviders"
import { createFakeTrpcClient } from "../test/fakeTrpcClient"
import { RequiresCapability } from "./serverCapabilities"

/** A fake server (labelled: no real server) whose hello lists only `capabilities`. */
function renderWith(capabilities: string[]) {
  const client = createFakeTrpcClient({
    "server.hello": () => ({
      protocol: 1,
      build: "fake",
      version: "0.0.0",
      pid: 1,
      capabilities,
    }),
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <RequiresCapability capability="devices">
        <button type="button">Revoke</button>
      </RequiresCapability>
      <RequiresCapability capability="answer-request">
        <button type="button">Answer</button>
      </RequiresCapability>
    </AppProviders>,
  )
}

test("an action the connected server does not list in its hello is hidden", async () => {
  renderWith(["devices"])
  expect(await screen.findByRole("button", { name: "Revoke" })).toBeTruthy()
  await waitFor(() => expect(screen.queryByRole("button", { name: "Answer" })).toBeNull())
})
