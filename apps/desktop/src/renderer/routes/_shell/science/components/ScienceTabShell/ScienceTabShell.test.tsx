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
        <ScienceTabShell
          layout="flush"
          title="Analysis"
          actions={<button type="button">Refresh</button>}
        >
          Content
        </ScienceTabShell>
      </AppProviders>,
    )

    const control = await screen.findByTestId("caffeine-control")
    // Caffeine sits in the title bar controls group, in the same header as the route actions.
    const header = control.closest("header")
    expect(header?.contains(screen.getByRole("button", { name: "Refresh" }))).toBe(true)
  })

  test("draws LaTeX in the title as the stylised logo", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AppProviders
        client={createFakeTrpcClient({
          "caffeine.status": () => ({ mode: "auto", scope: "system-only", held: true }),
        })}
        queryClient={queryClient}
      >
        <ScienceTabShell layout="flush" title="LaTeX Editor">
          Content
        </ScienceTabShell>
      </AppProviders>,
    )
    const heading = await screen.findByRole("heading", { level: 1 })
    expect(heading.querySelector('[data-testid="latex-logo"]')).not.toBeNull()
  })

  test("the page title in the top bar is not bold and keeps its size", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AppProviders
        client={createFakeTrpcClient({
          "caffeine.status": () => ({ mode: "auto", scope: "system-only", held: true }),
        })}
        queryClient={queryClient}
      >
        <ScienceTabShell layout="flush" title="Analysis">
          Content
        </ScienceTabShell>
      </AppProviders>,
    )
    const heading = await screen.findByRole("heading", { level: 1, name: "Analysis" })
    expect(heading.className).not.toMatch(/font-(semibold|bold|medium)/)
    expect(heading.className).toContain("text-sm")
  })
})
