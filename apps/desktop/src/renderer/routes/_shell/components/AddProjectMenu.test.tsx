import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../test/fakeTrpcClient"
import { AddProjectMenu } from "./AddProjectMenu"

const MENU_SIZE = { width: 256, height: 200 }

function renderDashboardCard() {
  const client = createFakeTrpcClient({})
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <AddProjectMenu variant="dashboard-card" onAdded={vi.fn()} />
    </AppProviders>,
  )
}

describe("AddProjectMenu dashboard card placement", () => {
  beforeEach(() => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000)
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(700)
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const isMenu = this.dataset.testid === "add-project-menu"
      const width = isMenu ? MENU_SIZE.width : 0
      const height = isMenu ? MENU_SIZE.height : 0
      return new DOMRect(0, 0, width, height)
    })
  })
  afterEach(() => vi.restoreAllMocks())

  test("anchors the menu's top-left corner at the click point", () => {
    renderDashboardCard()
    fireEvent.click(screen.getByTestId("dashboard-add-project"), {
      detail: 1,
      clientX: 300,
      clientY: 250,
    })
    const menu = screen.getByTestId("add-project-menu")
    expect(menu.style.left).toBe("300px")
    expect(menu.style.top).toBe("250px")
    expect(menu.className).not.toContain("-translate-x-1/2")
  })

  test("stays anchored when switching to the clone step", () => {
    renderDashboardCard()
    fireEvent.click(screen.getByTestId("dashboard-add-project"), {
      detail: 1,
      clientX: 300,
      clientY: 250,
    })
    fireEvent.click(screen.getByTestId("add-project-clone"))
    const menu = screen.getByTestId("add-project-menu")
    expect(screen.getByTestId("add-project-clone-form")).toBeTruthy()
    expect(menu.style.left).toBe("300px")
    expect(menu.style.top).toBe("250px")
  })

  test("shifts the menu to fit inside the right and bottom edges", () => {
    renderDashboardCard()
    fireEvent.click(screen.getByTestId("dashboard-add-project"), {
      detail: 1,
      clientX: 990,
      clientY: 690,
    })
    const menu = screen.getByTestId("add-project-menu")
    expect(menu.style.left).toBe(`${1000 - MENU_SIZE.width - 8}px`)
    expect(menu.style.top).toBe(`${700 - MENU_SIZE.height - 8}px`)
  })

  test("keeps the current placement for keyboard activation", () => {
    renderDashboardCard()
    fireEvent.click(screen.getByTestId("dashboard-add-project"), { detail: 0 })
    const menu = screen.getByTestId("add-project-menu")
    expect(menu.style.left).toBe("")
    expect(menu.className).toContain("-translate-x-1/2")
  })
})

describe("AddProjectMenu open from folder", () => {
  /**
   * The native folder picker takes the window's focus while it is open. The menu
   * must stay open through that, or the picked folder is never added.
   */
  test("adds the picked folder even though the folder picker took the window's focus", async () => {
    let finishPick: (path: string) => void = () => undefined
    const opened: unknown[] = []
    const client = createFakeTrpcClient({
      "system.pickDirectory": () =>
        new Promise<string>((resolve) => {
          finishPick = resolve
        }),
      "projects.open": (input) => {
        opened.push(input)
        return { id: "p1", name: "my-project" }
      },
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AppProviders client={client} queryClient={queryClient}>
        <AddProjectMenu variant="dashboard-card" onAdded={vi.fn()} />
      </AppProviders>,
    )
    fireEvent.click(screen.getByTestId("dashboard-add-project"), { detail: 0 })
    fireEvent.click(screen.getByTestId("add-project-folder"))
    fireEvent.blur(window)
    await new Promise((resolve) => setTimeout(resolve, 0))
    finishPick("/tmp/my-project")
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    expect((opened[0] as { path: string }).path).toBe("/tmp/my-project")
  })
})
