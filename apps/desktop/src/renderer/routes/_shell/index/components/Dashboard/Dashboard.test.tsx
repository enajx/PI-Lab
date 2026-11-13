import { QueryClient } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, test } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { ProjectActivityProvider } from "../../../-ProjectActivity"
import { AddProjectControllerProvider } from "../../../components/AddProjectController"
import { seedPalette } from "../../utils/projectGradient"
import { Dashboard } from "./Dashboard"

/**
 * Component test for the project-cards Dashboard. Mounts it under
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
    "projects.thumbnail": () => ({ dataUrl: null, tooLarge: false }),
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
      <ProjectActivityProvider>
        <AddProjectControllerProvider>
          {/* biome-ignore lint/suspicious/noExplicitAny: test router type plumbing. */}
          <RouterProvider router={router as any} />
        </AddProjectControllerProvider>
      </ProjectActivityProvider>
    </AppProviders>,
  )
  return { ...result, queryClient, router }
}

function project(
  id: string,
  name: string,
  thumbnail: string | null = null,
  gradient: { seed: number; palette: string[] } | null = null,
  archivedAt: number | null = null,
) {
  return {
    id,
    repoPath: `/tmp/${id}`,
    name,
    defaultBranch: "main",
    color: null,
    hasThumbnail: thumbnail !== null,
    gradient,
    sortIndex: 0,
    archivedAt,
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: 0,
  }
}

describe("Dashboard", () => {
  beforeEach(() => window.localStorage.clear())

  test("uses the Projects Dashboard name", async () => {
    renderDashboard({ "projects.list": () => [] })

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Projects Dashboard" })).toBeTruthy()
    })
    expect(screen.getByTestId("caffeine-control")).toBeTruthy()
    expect(
      screen
        .getByRole("heading", { name: "Projects Dashboard" })
        .closest("header")
        ?.classList.contains("app-drag"),
    ).toBe(true)
    const title = screen.getByRole("heading", { name: "Projects Dashboard" })
    expect(title.className).not.toMatch(/font-(semibold|bold|medium)/)
    expect(title.className).toContain("text-sm")
  })

  test("translates dashboard copy after choosing Norwegian", async () => {
    window.localStorage.setItem("pi-lab.interface.language", "nb")
    renderDashboard({ "projects.list": () => [] })

    expect(await screen.findByRole("heading", { name: "Prosjektoversikt" })).toBeTruthy()
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

  test("hides archived cards by default, reveals them dimmed, and restores them from the card menu", async () => {
    let projects = [
      project("visible", "Visible Project", null, { seed: 1, palette: ["#111"] }),
      project("hidden", "Hidden Project", null, { seed: 2, palette: ["#222"] }, 123),
    ]
    const archivedCalls: unknown[] = []
    renderDashboard({
      "projects.list": () => projects,
      "workspaces.list": () => [],
      "projects.setArchived": (input) => {
        archivedCalls.push(input)
        const { id, archived } = input as { id: string; archived: boolean }
        projects = projects.map((row) =>
          row.id === id ? { ...row, archivedAt: archived ? Date.now() : null } : row,
        )
        return projects.find((row) => row.id === id)
      },
    })

    await screen.findByText("Visible Project")
    expect(screen.queryByText("Hidden Project")).toBeNull()
    expect(screen.getByTestId("dashboard-show-hidden-projects").textContent).toContain(
      "Show hidden (1)",
    )

    fireEvent.click(screen.getByTestId("dashboard-show-hidden-projects"))
    const hiddenCard = (await screen.findByText("Hidden Project")).closest(
      '[data-testid="project-card"]',
    )
    if (!(hiddenCard instanceof HTMLElement)) throw new Error("Hidden project card missing")
    expect(hiddenCard.getAttribute("data-hidden")).toBe("true")
    expect(hiddenCard.className).toContain("opacity-60")

    fireEvent.contextMenu(
      hiddenCard.querySelector('[data-testid="project-card-image"]') as HTMLElement,
    )
    fireEvent.click(await screen.findByTestId("project-card-menu-restore"))

    await waitFor(() => expect(archivedCalls).toEqual([{ id: "hidden", archived: false }]))
    await waitFor(() => expect(screen.queryByTestId("dashboard-show-hidden-projects")).toBeNull())
    expect(screen.getByText("Hidden Project")).toBeTruthy()
  })

  test("hides a visible project from its card menu without deleting other project state", async () => {
    let projects = [project("p1", "Hide Me", null, { seed: 1, palette: ["#111"] })]
    const archivedCalls: unknown[] = []
    renderDashboard({
      "projects.list": () => projects,
      "workspaces.list": () => [],
      "projects.setArchived": (input) => {
        archivedCalls.push(input)
        const { id } = input as { id: string }
        projects = projects.map((row) => (row.id === id ? { ...row, archivedAt: Date.now() } : row))
        return projects[0]
      },
    })

    fireEvent.contextMenu(await screen.findByTestId("project-card-image"))
    fireEvent.click(await screen.findByTestId("project-card-menu-hide"))

    await waitFor(() => expect(archivedCalls).toEqual([{ id: "p1", archived: true }]))
    await waitFor(() => expect(screen.queryByTestId("project-card")).toBeNull())
    expect(screen.getByTestId("dashboard-show-hidden-projects")).toBeTruthy()
  })

  test("a project with a working agent reads as active", async () => {
    renderDashboard({
      "projects.list": () => [project("p1", "Active Project")],
      "workspaces.list": () => [],
      "sessions.onStatus": () => [{ projectId: "p1", state: "working" }],
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
      "220",
    )
    expect(screen.getByTestId("project-card-grid-item").getAttribute("data-card-span")).toBe("1x1")
    expect(screen.getByTestId("card-resize-handle")).toBeTruthy()
  })

  test("spaces the cards apart and leaves two card gaps of space above the grid", async () => {
    renderDashboard({
      "projects.list": () => [project("p1", "Anything")],
      "workspaces.list": () => [],
    })

    await screen.findByTestId("project-card")
    const grid = screen.getByTestId("dashboard-grid")
    // gap-6 is 24px between cards; pt-12 is 48px, two gaps, above the first row.
    expect(grid.className).toContain("gap-6")
    expect(grid.parentElement?.className).toContain("pt-12")
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
    ).toBeGreaterThanOrEqual(6)
    expect(screen.getByTestId("project-card-gradient-grain")).toBeTruthy()
  })

  test("a no-thumbnail card with no stored gradient persists a default with colors from its seed", async () => {
    const calls: unknown[] = []
    renderDashboard({
      "projects.list": () => [project("p1", "Fresh Project")],
      "workspaces.list": () => [],
      "projects.setGradient": (input) => {
        calls.push(input)
        return project("p1", "Fresh Project")
      },
    })

    // The card still renders a gradient immediately (from the seeded default)...
    await screen.findByTestId("project-card-gradient")
    // ...and persists that default exactly once, as a { seed, palette } pair.
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({ id: "p1" })
    const { gradient } = calls[0] as { gradient: { seed: number; palette: string[] } }
    expect(typeof gradient.seed).toBe("number")
    expect(gradient.palette).toEqual(seedPalette(gradient.seed))
  })

  test("right-click → Set thumbnail generates a new gradient with colors from its seed", async () => {
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
    fireEvent.click(await screen.findByTestId("project-card-menu-thumbnail"))
    fireEvent.click(await screen.findByTestId("project-card-artwork-gradient"))

    await waitFor(() => expect(calls).toHaveLength(1))
    const { gradient } = calls[0] as { gradient: { seed: number; palette: string[] } }
    expect(typeof gradient.seed).toBe("number")
    expect(gradient.palette).toEqual(seedPalette(gradient.seed))
    // The menu closes after the action.
    expect(screen.queryByTestId("project-card-menu")).toBeNull()
  })

  test("a card with a thumbnail renders no gradient layer", async () => {
    renderDashboard({
      "projects.list": () => [project("p1", "Pictured Project", "data:image/png;base64,AAAA")],
      "projects.thumbnail": () => ({ dataUrl: "data:image/png;base64,AAAA", tooLarge: false }),
      "workspaces.list": () => [],
    })

    await waitFor(() => {
      expect(screen.getByTestId("project-card")).toBeTruthy()
    })
    expect(screen.queryByTestId("project-card-gradient")).toBeNull()
    expect(screen.queryByTestId("project-card-gradient-layer")).toBeNull()
    expect(screen.queryByTestId("project-card-gradient-grain")).toBeNull()
    await waitFor(() => {
      expect(
        screen.getByTestId("project-card-image").querySelector("img")?.getAttribute("src"),
      ).toBe("data:image/png;base64,AAAA")
    })
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
    const file = new File(
      [Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", "base64")],
      "thumbnail.gif",
      { type: "image/gif" },
    )
    fireEvent.drop(image, { dataTransfer: { files: [file] } })

    await waitFor(() => {
      expect(updates).toHaveLength(1)
    })
    expect(updates[0]).toMatchObject({ id: "p1" })
    expect((updates[0] as { dataUrl: string }).dataUrl).toMatch(/^data:image\/gif;base64,/)
  })

  describe("moving cards", () => {
    /** Lay the grid items out in one row, 250px apart (jsdom has no layout of its own). */
    function layOutCardsInARow() {
      const original = Element.prototype.getBoundingClientRect
      Element.prototype.getBoundingClientRect = function (this: Element) {
        const item = this.closest("[data-card-grid-item]")
        if (!item) return original.call(this)
        const items = [...document.querySelectorAll("[data-card-grid-item]")]
        const left = items.indexOf(item) * 250
        return DOMRect.fromRect({ x: left, y: 0, width: 220, height: 236 })
      }
      return () => {
        Element.prototype.getBoundingClientRect = original
      }
    }

    function cardNames(): string[] {
      return screen.getAllByTestId("project-card-title").map((el) => el.textContent ?? "")
    }

    test("Space, an arrow key and Space move a card and save the new order of every project", async () => {
      const restoreLayout = layOutCardsInARow()
      let projects = [
        project("p1", "Photon Drift"),
        project("hidden", "Hidden One", null, null, 5),
        project("p2", "Lattice QCD"),
        project("p3", "Dark Matter"),
      ]
      const reorderCalls: unknown[] = []
      renderDashboard({
        "projects.list": () => projects,
        "workspaces.list": () => [],
        "projects.reorder": (input) => {
          reorderCalls.push(input)
          const { ids } = input as { ids: string[] }
          projects = ids.flatMap((id) => projects.filter((row) => row.id === id))
          return undefined
        },
      })
      await waitFor(() =>
        expect(cardNames()).toEqual(["Photon Drift", "Lattice QCD", "Dark Matter"]),
      )

      const first = screen.getAllByTestId("project-card-grid-item")[0] as HTMLElement
      first.focus()
      fireEvent.keyDown(first, { code: "Space", key: " " })
      await waitFor(() => expect(first.getAttribute("aria-pressed")).toBe("true"))
      fireEvent.keyDown(first, { code: "ArrowRight", key: "ArrowRight" })
      fireEvent.keyDown(first, { code: "Space", key: " " })

      await waitFor(() => expect(reorderCalls).toEqual([{ ids: ["p2", "hidden", "p1", "p3"] }]))
      await waitFor(() =>
        expect(cardNames()).toEqual(["Lattice QCD", "Photon Drift", "Dark Matter"]),
      )
      restoreLayout()
    })

    test("a click on a draggable card still opens the project", async () => {
      const { router } = renderDashboard({
        "projects.list": () => [project("p1", "Photon Drift"), project("p2", "Lattice QCD")],
        "workspaces.list": () => [],
      })
      const image = (await screen.findAllByTestId("project-card-image"))[0] as HTMLElement
      fireEvent.pointerDown(image, { button: 0, isPrimary: true, clientX: 10, clientY: 10 })
      fireEvent.pointerUp(image, { button: 0, isPrimary: true, clientX: 10, clientY: 10 })
      fireEvent.click(image)
      await waitFor(() => expect(router.state.location.pathname).toBe("/projects/p1"))
    })

    test("the New project card cannot be picked up", async () => {
      renderDashboard({
        "projects.list": () => [project("p1", "Photon Drift")],
        "workspaces.list": () => [],
      })
      await screen.findByTestId("project-card-grid-item")
      expect(
        screen.getByTestId("project-card-grid-item").getAttribute("aria-roledescription"),
      ).toBe("sortable")
      const shadowCard = screen.getByTestId("new-project-card")
      expect(shadowCard.getAttribute("aria-roledescription")).toBeNull()
      expect(shadowCard.querySelector("[aria-roledescription]")).toBeNull()
    })
  })

  test("using the resize handle does not navigate the project card", async () => {
    const { router } = renderDashboard({
      "projects.list": () => [project("p1", "Photon Drift")],
      "workspaces.list": () => [],
    })

    fireEvent.click(await screen.findByTestId("card-resize-handle"))
    expect(router.state.location.pathname).toBe("/")
  })

  test("with no projects it shows only the New project card, with no empty-state text", async () => {
    renderDashboard({ "projects.list": () => [] })

    expect(await screen.findByRole("button", { name: "New project" })).toBeTruthy()
    expect(screen.queryByTestId("dashboard-empty")).toBeNull()
    expect(screen.queryByTestId("project-card")).toBeNull()
    expect(screen.getByRole("button", { name: "New project" })).toBeTruthy()
    expect(screen.getByTestId("dashboard-grid").hidden).toBe(false)
    expect(screen.queryByTestId("project-card-grid-item")).toBeNull()
    expect(screen.queryByTestId("card-resize-handle")).toBeNull()
  })

  test("keeps the New project card last and outside persisted project-card layout state", async () => {
    renderDashboard({
      "projects.list": () => [project("p1", "Photon Drift"), project("p2", "Lattice QCD")],
      "workspaces.list": () => [],
    })

    await screen.findAllByTestId("project-card-grid-item")
    const trigger = screen.getByRole("button", { name: "New project" })
    const shadowCard = trigger.closest('[data-testid="new-project-card"]')
    if (!(shadowCard instanceof HTMLElement)) throw new Error("New project card missing")
    const grid = screen.getByTestId("dashboard-grid")

    expect(grid.lastElementChild).toBe(shadowCard)
    expect(shadowCard.hasAttribute("data-card-grid-item")).toBe(false)
    expect(screen.getAllByTestId("project-card-grid-item")).toHaveLength(2)
    expect(screen.getAllByTestId("card-resize-handle")).toHaveLength(2)
  })

  test("opens the shared three-option Add Project chooser from the keyboard-accessible card", async () => {
    renderDashboard({ "projects.list": () => [] })

    const trigger = await screen.findByRole("button", { name: "New project" })
    trigger.focus()
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(trigger)

    expect(screen.getByTestId("add-project-menu")).toBeTruthy()
    expect(screen.getByTestId("add-project-folder")).toBeTruthy()
    expect(screen.getByTestId("add-project-clone")).toBeTruthy()
    expect(screen.getByTestId("add-project-template")).toBeTruthy()
  })

  test("surfaces Add Project errors from the Dashboard card", async () => {
    renderDashboard({
      "projects.list": () => [],
      "system.pickDirectory": () => {
        throw new Error("Folder picker unavailable")
      },
    })

    fireEvent.click(await screen.findByRole("button", { name: "New project" }))
    fireEvent.click(screen.getByTestId("add-project-folder"))

    await waitFor(() => {
      expect(screen.getByTestId("add-project-error").textContent).toContain(
        "Folder picker unavailable",
      )
    })
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

    await waitFor(() => expect(screen.queryByTestId("project-card")).toBeNull())
    expect(screen.queryByTestId("dashboard-empty")).toBeNull()
    expect(screen.getByTestId("dashboard-grid").hidden).toBe(false)
    expect(screen.getByRole("button", { name: "New project" })).toBeTruthy()
    await waitFor(() => {
      expect(window.localStorage.getItem("pi-lab.cardGrid.dashboard.spans")).toBeNull()
    })
  })
})
