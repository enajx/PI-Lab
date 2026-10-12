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
import { SettingsView } from "./settings/-SettingsView"

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
    expect(screen.getByTestId("settings-back").textContent).toContain("Back")
    expect(header?.className).toContain("pl-24")
  })

  test("opens the Appearance Advanced typography location from a deep link", async () => {
    const client = createFakeTrpcClient({
      "caffeine.status": () => ({ mode: "off", scope: "system-only", held: false }),
      "system.fonts": () => ({ families: ["Menlo"], error: null }),
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const rootRoute = createRootRoute({ component: SettingsView })
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({
        initialEntries: ["/?section=appearance&advanced=editor-typography"],
      }),
    })

    render(
      <AppProviders client={client} queryClient={queryClient}>
        {/* biome-ignore lint/suspicious/noExplicitAny: test router type plumbing. */}
        <RouterProvider router={router as any} />
      </AppProviders>,
    )

    expect(await screen.findByTestId("settings-section-appearance")).toBeTruthy()
    expect(screen.getByTestId("appearance-advanced-editor-typography")).toBeTruthy()
    expect(screen.getByTestId("settings-nav-appearance").getAttribute("data-active")).toBe("true")
  })
})
