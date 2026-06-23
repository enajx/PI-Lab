import { QueryClient } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { Dashboard } from "./Dashboard"

/**
 * Component test for the project-cards Dashboard (AGENTS.md §14). Mounts it under
 * the real providers + a router (so the card's `useNavigate` resolves) with a
 * faked tRPC client. jsdom suffices — the cards render plain DOM (no Radix), and
 * we only assert structure: cards-by-name, the status badge, the size slider, and
 * the empty state.
 */

function renderDashboard(handlers: FakeHandlers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)

  const rootRoute = createRootRoute({ component: Dashboard })
  // A stub project route so the card's navigate target type-checks/resolves.
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$projectId",
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([projectRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })

  return render(
    <AppProviders client={client} queryClient={queryClient}>
      {/* biome-ignore lint/suspicious/noExplicitAny: test router type plumbing. */}
      <RouterProvider router={router as any} />
    </AppProviders>,
  )
}

function project(id: string, name: string) {
  return {
    id,
    repoPath: `/tmp/${id}`,
    name,
    defaultBranch: "main",
    color: null,
    thumbnail: null,
    sortIndex: 0,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: 0,
  }
}

describe("Dashboard", () => {
  test("renders a card per project with its name and a status badge", async () => {
    renderDashboard({
      "projects.list": () => [project("p1", "Photon Drift"), project("p2", "Lattice QCD")],
      "workspaces.list": () => [],
    })

    await waitFor(() => {
      expect(screen.getAllByTestId("project-card")).toHaveLength(2)
    })
    expect(screen.getByText("Photon Drift")).toBeTruthy()
    expect(screen.getByText("Lattice QCD")).toBeTruthy()
    // No workspaces ⇒ idle status on each card.
    const statuses = screen.getAllByTestId("project-card-status")
    expect(statuses.every((el) => el.getAttribute("data-state") === "idle")).toBe(true)
  })

  test("a project with workspaces reads as active", async () => {
    renderDashboard({
      "projects.list": () => [project("p1", "Active Project")],
      "workspaces.list": () => [{ id: "w1" }],
    })

    await waitFor(() => {
      expect(screen.getByTestId("project-card-status").getAttribute("data-state")).toBe("active")
    })
  })

  test("shows the card-size slider", async () => {
    renderDashboard({
      "projects.list": () => [project("p1", "Anything")],
      "workspaces.list": () => [],
    })

    await waitFor(() => {
      expect(screen.getByTestId("card-size-slider")).toBeTruthy()
    })
    expect((screen.getByTestId("card-size-slider") as HTMLInputElement).type).toBe("range")
  })

  test("shows the empty state when there are no projects", async () => {
    renderDashboard({ "projects.list": () => [] })

    await waitFor(() => {
      expect(screen.getByTestId("dashboard-empty")).toBeTruthy()
    })
    expect(screen.queryByTestId("project-card")).toBeNull()
  })
})
