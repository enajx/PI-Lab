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
import { AppProviders } from "../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../test/fakeTrpcClient"
import { Sidebar } from "./Sidebar"

/**
 * Component test for the left sidebar (docs/testing-and-build.md). Mounts the
 * real `Sidebar` under the app providers + a memory router (so its `<Link>`s
 * resolve) with a faked tRPC client. jsdom suffices — the sidebar is plain DOM
 * (no Radix). We cover the unified workspace nav (Workflows still reachable), the
 * persisted project ordering, and the Add-project dropdown (the template item is
 * now a direct folder pick, not an inline name form).
 */

function renderSidebar(handlers: FakeHandlers = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({ "projects.list": () => [], ...handlers })

  // A handful of stub routes so the sidebar's `<Link>` targets resolve.
  const rootRoute = createRootRoute({ component: Sidebar })
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      stub("/projects/$projectId"),
      stub("/automations"),
      stub("/settings"),
      stub("/science/library"),
      stub("/science/analysis"),
      stub("/science/cluster"),
      stub("/science/skills"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })

  return render(
    <AppProviders client={client} queryClient={queryClient}>
      {/* biome-ignore lint/suspicious/noExplicitAny: test router type plumbing. */}
      <RouterProvider router={router as any} />
    </AppProviders>,
  )
}

describe("Sidebar", () => {
  // Reset persisted layout prefs (nav/project order) so tests don't bleed order.
  beforeEach(() => {
    window.localStorage.clear()
  })

  test("the Add-project trigger opens a menu with three options", async () => {
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("add-project")).toBeTruthy())

    expect(screen.queryByTestId("add-project-menu")).toBeNull()

    fireEvent.click(screen.getByTestId("add-project"))

    expect(screen.getByTestId("add-project-menu")).toBeTruthy()
    expect(screen.getByTestId("add-project-folder")).toBeTruthy()
    expect(screen.getByTestId("add-project-clone")).toBeTruthy()
    expect(screen.getByTestId("add-project-template")).toBeTruthy()
  })

  test("the clone item reveals an inline git-URL form", async () => {
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("add-project")).toBeTruthy())

    fireEvent.click(screen.getByTestId("add-project"))
    fireEvent.click(screen.getByTestId("add-project-clone"))

    expect(screen.getByTestId("add-project-clone-form")).toBeTruthy()
    expect(screen.getByTestId("add-project-clone-url")).toBeTruthy()
    // The folder/template items give way to the form once a mode is chosen.
    expect(screen.queryByTestId("add-project-folder")).toBeNull()
  })

  test("the template item picks a target folder and creates — no inline name form", async () => {
    let templateInput: unknown
    renderSidebar({
      "system.pickDirectory": () => "/tmp/target",
      "projects.createFromTemplate": (input) => {
        templateInput = input
        return { id: "tmpl", name: "tmpl", repoPath: "/tmp/target" }
      },
    })
    await waitFor(() => expect(screen.getByTestId("add-project")).toBeTruthy())

    fireEvent.click(screen.getByTestId("add-project"))
    fireEvent.click(screen.getByTestId("add-project-template"))

    // No inline name form any more — it's a direct folder pick → createFromTemplate.
    expect(screen.queryByTestId("add-project-template-form")).toBeNull()
    await waitFor(() => expect(templateInput).toEqual({ targetDir: "/tmp/target" }))
  })

  test("Escape closes the menu", async () => {
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("add-project")).toBeTruthy())

    fireEvent.click(screen.getByTestId("add-project"))
    expect(screen.getByTestId("add-project-menu")).toBeTruthy()

    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByTestId("add-project-menu")).toBeNull()
  })

  test("Workflows is reachable inside the single workspace nav", async () => {
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("nav-automations")).toBeTruthy())

    const workflows = screen.getByTestId("nav-automations")
    expect(workflows.textContent).toContain("Workflows")
    // Workflows shares the one nav with the science rows (not a separate block).
    expect(screen.getByTestId("science-nav").contains(workflows)).toBe(true)
    expect(screen.getAllByTestId("science-nav-item").length).toBeGreaterThan(0)
  })

  test("projects render in the persisted order, with new ids appended", async () => {
    window.localStorage.setItem("skipper.sidebar.projectOrder", JSON.stringify(["c", "a"]))
    renderSidebar({
      "projects.list": () => [
        { id: "a", name: "Alpha", repoPath: "/a" },
        { id: "b", name: "Beta", repoPath: "/b" },
        { id: "c", name: "Gamma", repoPath: "/c" },
      ],
    })
    await waitFor(() => expect(screen.getAllByTestId("project-item").length).toBe(3))

    const ids = screen
      .getAllByTestId("project-item")
      .map((el) => el.getAttribute("data-project-id"))
    // Stored ids first (c, a), then the not-yet-stored id (b) in natural order.
    expect(ids).toEqual(["c", "a", "b"])
  })

  test("the theme-aware app logo renders in the title bar (light theme by default)", async () => {
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("sidebar-app-logo")).toBeTruthy())

    const src = screen.getByTestId("sidebar-app-logo").getAttribute("src") ?? ""
    // Light theme picks the dark-on-light glyph, not its negative.
    expect(src).toContain("icon_bw")
    expect(src).not.toContain("negative")
  })

  test("the app logo swaps to the negative variant in the dark theme", async () => {
    window.localStorage.setItem("skipper.theme", "dark")
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("sidebar-app-logo")).toBeTruthy())

    const src = screen.getByTestId("sidebar-app-logo").getAttribute("src") ?? ""
    expect(src).toContain("icon_bw_negative")
  })

  test("the app logo still renders when the sidebar is collapsed", async () => {
    window.localStorage.setItem("skipper.sidebar.collapsed", "true")
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("app-sidebar")).toBeTruthy())

    expect(screen.getByTestId("app-sidebar").getAttribute("data-collapsed")).toBe("true")
    expect(screen.getByTestId("sidebar-app-logo")).toBeTruthy()
  })

  test("right-clicking a project opens a menu that removes it from the app", async () => {
    let removeInput: unknown
    renderSidebar({
      "projects.list": () => [{ id: "a", name: "Alpha", repoPath: "/a" }],
      "projects.remove": (input) => {
        removeInput = input
        return { id: "a", name: "Alpha", repoPath: "/a" }
      },
    })
    await waitFor(() => expect(screen.getByTestId("project-item")).toBeTruthy())

    // The menu only appears on right-click.
    expect(screen.queryByTestId("project-context-menu")).toBeNull()
    fireEvent.contextMenu(screen.getByTestId("project-item"))
    expect(screen.getByTestId("project-context-menu")).toBeTruthy()

    fireEvent.click(screen.getByTestId("project-remove"))
    await waitFor(() => expect(removeInput).toEqual({ id: "a" }))
    // Removing closes the menu.
    expect(screen.queryByTestId("project-context-menu")).toBeNull()
  })
})
