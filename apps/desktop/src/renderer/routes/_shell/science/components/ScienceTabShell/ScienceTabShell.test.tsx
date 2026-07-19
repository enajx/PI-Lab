import { QueryClient } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../../../test/fakeTrpcClient"
import { ScienceTabShell } from "./ScienceTabShell"

describe("ScienceTabShell", () => {
  test("reserves the shared Science route header for Caffeine beside route actions", async () => {
    const client = createFakeTrpcClient({
      "caffeine.status": () => ({ mode: "auto", scope: "system-only", held: true }),
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AppProviders client={client} queryClient={queryClient}>
        <ScienceTabShell title="Analysis" actions={<button type="button">Refresh</button>}>
          Content
        </ScienceTabShell>
      </AppProviders>,
    )

    const control = await screen.findByTestId("caffeine-control")
    expect(control.closest("header")).toBeTruthy()
    expect(control.parentElement?.contains(screen.getByRole("button", { name: "Refresh" }))).toBe(
      true,
    )
  })
})
