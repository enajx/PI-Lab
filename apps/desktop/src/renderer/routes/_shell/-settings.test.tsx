import { QueryClient } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { render, screen } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { AppProviders } from "../../providers/AppProviders"
import { createFakeTrpcClient } from "../../test/fakeTrpcClient"
import { SettingsView } from "./settings"

describe("SettingsView", () => {
  test("keeps Caffeine clickable in the draggable Settings header", async () => {
    const client = createFakeTrpcClient({
      "caffeine.status": () => ({ mode: "on", scope: "system-only", held: true }),
      "settings.get": () => ({ confirmOnQuit: true }),
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const rootRoute = createRootRoute({ component: SettingsView })
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    })

    render(
      <AppProviders client={client} queryClient={queryClient}>
        {/* biome-ignore lint/suspicious/noExplicitAny: test router type plumbing. */}
        <RouterProvider router={router as any} />
      </AppProviders>,
    )

    const control = await screen.findByTestId("caffeine-control")
    const header = control.closest("header")
    expect(header?.classList.contains("app-drag")).toBe(true)
    expect(control.classList.contains("app-no-drag")).toBe(true)
    expect(header?.contains(screen.getByRole("heading", { name: "Settings" }))).toBe(true)
  })
})
