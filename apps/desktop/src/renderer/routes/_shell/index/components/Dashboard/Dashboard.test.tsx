import { QueryClient } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { Dashboard } from "./Dashboard"

/**
 * Component test for the project-cards Dashboard (md/engineering/testing-and-build.md). Mounts it under
 * the real providers + a router (so the card's `useNavigate` resolves) with a
 * faked tRPC client. jsdom suffices — the cards render plain DOM (no Radix), and
 * we assert public structure and interactions: cards-by-name, status, direct
 * resizing, thumbnail drop, navigation isolation, and the empty state.
 */

function renderDashboard(handlers: FakeHandlers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({
    "caffeine.status": () => ({ mode: "off", scope: "system-only", held: false }),
    // No-thumbnail cards persist a default gradient on first render; tolerate it
    // unless a test overrides this to assert on the call.
    "projects.setGradient": (input) => {
      const { id } = input as { id: string }
      return project(id, id)
    },
    ...handlers,
  })

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

  const result = render(
    <AppProviders client={client} queryClient={queryClient}>
      {/* biome-ignore lint/suspicious/noExplicitAny: test router type plumbing. */}
      <RouterProvider router={router as any} />
    </AppProviders>,
  )
  return { ...result, queryClient, router }
}

function project(
  id: string,
  name: string,
  thumbnail: string | null = null,
  gradient: { seed: number; palette: string[] } | null = null,
) {
  return {
    id,
    repoPath: `/tmp/${id}`,
    name,
    defaultBranch: "main",
    color: null,
    thumbnail,
    gradient,
    sortIndex: 0,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: 0,
  }
}

describe("Dashboard", () => {
  test("uses the Projects Dashboard name", async () => {
    renderDashboard({ "projects.list": () => [] })

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Projects Dashboard" })).toBeTruthy()
    })
    expect(screen.getByTestId("caffeine-control")).toBeTruthy()
  })

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

  test("a project with a working agent reads as active", async () => {
    renderDashboard({
      "projects.list": () => [project("p1", "Active Project")],
      "workspaces.list": () => [],
      "sessions.activity": () => [{ projectId: "p1", state: "working" }],
    })

    await waitFor(() => {
      expect(screen.getByTestId("project-card-status").getAttribute("data-state")).toBe("active")
    })
  })

  test("removes the scalar card-size slider", async () => {
    renderDashboard({
      "projects.list": () => [project("p1", "Anything")],
      "workspaces.list": () => [],
    })

    await screen.findByTestId("project-card")
    expect(screen.queryByTestId("card-size-slider")).toBeNull()
    expect(screen.getByTestId("dashboard-grid").getAttribute("data-card-grid-base-column")).toBe(
      "200",
    )
    expect(screen.getByTestId("project-card-grid-item").getAttribute("data-card-span")).toBe("1x1")
    expect(screen.getByTestId("card-resize-handle")).toBeTruthy()
  })

  test("a card renders its stored gradient as three baked, drifting layers", async () => {
    renderDashboard({
      "projects.list": () => [
        project("p1", "Gradient Project", null, { seed: 42, palette: ["#FFC700", "#18A0FB"] }),
      ],
      "workspaces.list": () => [],
    })

    const field = await screen.findByTestId("project-card-gradient")
    expect(field.classList.contains("project-gradient-field")).toBe(true)
    // Motion family drives both the class and a debug attribute.
    expect(field.dataset.gradientMotion).toMatch(/^(meander|turn|breathe|weave|orbit|rock)$/)
    expect(
      field.classList.contains(`project-gradient-motion-${field.dataset.gradientMotion}`),
    ).toBe(true)
    expect(field.dataset.gradientSeed).toBe("42")

    // Three stacked drift layers (their baked data-URI backgrounds are asserted in
    // projectGradient.test.ts; jsdom drops complex `url(data:…)` background-image).
    const layers = screen.getAllByTestId("project-card-gradient-layer")
    expect(layers).toHaveLength(3)
    expect(layers.map((layer) => layer.dataset.layer)).toEqual(["a", "b", "c"])
    expect(field.style.getPropertyValue("--layer-a-duration")).toMatch(/^\d+(?:\.\d+)?s$/)
    expect(
      Number.parseFloat(field.style.getPropertyValue("--layer-a-duration")),
    ).toBeGreaterThanOrEqual(8)
    expect(screen.getByTestId("project-card-gradient-grain")).toBeTruthy()
  })

  test("a no-thumbnail card with no stored gradient persists a default sampled from the theme", async () => {
    const calls: unknown[] = []
    renderDashboard({
      "projects.list": () => [project("p1", "Fresh Project")],
      "workspaces.list": () => [],
      "projects.setGradient": (input) => {
        calls.push(input)
        return project("p1", "Fresh Project")
      },
    })

    // The card still renders a gradient immediately (from the sampled default)...
    await screen.findByTestId("project-card-gradient")
    // ...and persists that default exactly once, as a { seed, palette } pair.
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({ id: "p1" })
    const { gradient } = calls[0] as { gradient: { seed: number; palette: string[] } }
    expect(typeof gradient.seed).toBe("number")
    expect(gradient.palette.length).toBeGreaterThan(0)
  })

  test("right-click generates a new gradient sampled from the current theme", async () => {
    const calls: unknown[] = []
    renderDashboard({
      "projects.list": () => [
        project("p1", "Photon Drift", null, { seed: 1, palette: ["#FFC700"] }),
      ],
      "workspaces.list": () => [],
      "projects.setGradient": (input) => {
        calls.push(input)
        return project("p1", "Photon Drift")
      },
    })

    const image = await screen.findByTestId("project-card-image")
    fireEvent.contextMenu(image)
    fireEvent.click(await screen.findByTestId("project-card-menu-gradient"))

    await waitFor(() => expect(calls).toHaveLength(1))
    const { gradient } = calls[0] as { gradient: { seed: number; palette: string[] } }
    expect(typeof gradient.seed).toBe("number")
    expect(gradient.palette.length).toBeGreaterThan(0)
    // The menu closes after the action.
    expect(screen.queryByTestId("project-card-menu")).toBeNull()
  })

  test("a card with a thumbnail renders no gradient layer", async () => {
    renderDashboard({
      "projects.list": () => [project("p1", "Pictured Project", "data:image/png;base64,AAAA")],
      "workspaces.list": () => [],
    })

    await waitFor(() => {
      expect(screen.getByTestId("project-card")).toBeTruthy()
    })
    expect(screen.queryByTestId("project-card-gradient")).toBeNull()
    expect(screen.queryByTestId("project-card-gradient-layer")).toBeNull()
    expect(screen.queryByTestId("project-card-gradient-grain")).toBeNull()
    expect(screen.getByTestId("project-card-image").querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    )
  })

  test("clicking the card's thumbnail region opens the project", async () => {
    const { router } = renderDashboard({
      "projects.list": () => [project("p1", "Photon Drift")],
      "workspaces.list": () => [],
    })

    const image = await screen.findByTestId("project-card-image")
    fireEvent.click(image)

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/projects/p1")
    })
  })

  test("clicking the info region opens the project", async () => {
    const { router } = renderDashboard({
      "projects.list": () => [project("p1", "Photon Drift")],
      "workspaces.list": () => [],
    })

    const info = await screen.findByTestId("project-card-open")
    fireEvent.click(info)

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/projects/p1")
    })
  })

  test("dropping an image still persists the project thumbnail", async () => {
    const updates: unknown[] = []
    renderDashboard({
      "projects.list": () => [project("p1", "Photon Drift")],
      "workspaces.list": () => [],
      "projects.setThumbnail": (input) => {
        updates.push(input)
        return project("p1", "Photon Drift")
      },
    })

    const image = await screen.findByTestId("project-card-image")
    const file = new File(["pixels"], "thumbnail.png", { type: "image/png" })
    fireEvent.drop(image, { dataTransfer: { files: [file] } })

    await waitFor(() => {
      expect(updates).toHaveLength(1)
    })
    expect(updates[0]).toMatchObject({ id: "p1" })
    expect((updates[0] as { dataUrl: string }).dataUrl).toMatch(/^data:image\/png;base64,/)
  })

  test("using the resize handle does not navigate the project card", async () => {
    const { router } = renderDashboard({
      "projects.list": () => [project("p1", "Photon Drift")],
      "workspaces.list": () => [],
    })

    fireEvent.click(await screen.findByTestId("card-resize-handle"))
    expect(router.state.location.pathname).toBe("/")
  })

  test("shows the empty state when there are no projects", async () => {
    renderDashboard({ "projects.list": () => [] })

    await waitFor(() => {
      expect(screen.getByTestId("dashboard-empty")).toBeTruthy()
    })
    expect(screen.queryByTestId("project-card")).toBeNull()
    expect(screen.getByTestId("dashboard-grid").hidden).toBe(true)
  })

  test("clears legacy per-card spans when the result becomes empty", async () => {
    let projects = [project("p1", "Photon Drift")]
    window.localStorage.setItem("pi-lab.cardGrid.dashboard.spans", JSON.stringify({ p1: "2x2" }))
    const { queryClient } = renderDashboard({
      "projects.list": () => projects,
      "workspaces.list": () => [],
    })

    expect((await screen.findByTestId("project-card-grid-item")).dataset.cardSpan).toBe("1x1")
    projects = []
    await queryClient.invalidateQueries()

    await screen.findByTestId("dashboard-empty")
    expect(screen.getByTestId("dashboard-grid").hidden).toBe(true)
    await waitFor(() => {
      expect(window.localStorage.getItem("pi-lab.cardGrid.dashboard.spans")).toBeNull()
    })
  })
})
