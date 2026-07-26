import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, test } from "vitest"
import { CardGrid, ResizableCardGridItem } from "./CardGrid"

function dispatchPointer(
  target: Element | Window,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  values: { pointerId: number; clientX: number; clientY: number; button?: number },
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: values.button ?? 0,
    clientX: values.clientX,
    clientY: values.clientY,
  })
  Object.defineProperty(event, "pointerId", { value: values.pointerId })
  fireEvent(target, event)
}

function firstResizeHandle(): HTMLElement {
  const handle = screen.getAllByTestId("card-resize-handle")[0]
  if (!handle) throw new Error("Expected a card resize handle")
  return handle
}

function GridHarness({ surface = "dashboard" }: { surface?: "dashboard" | "cluster" }) {
  const ids = ["alpha", "beta"]
  return (
    <CardGrid surface={surface} cardIds={ids} testId="test-grid">
      {ids.map((id) => (
        <ResizableCardGridItem key={id} cardId={id} label={id} testId={`item-${id}`}>
          <div>{id}</div>
        </ResizableCardGridItem>
      ))}
    </CardGrid>
  )
}

describe("CardGrid", () => {
  beforeEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  test("defaults every card to one shared smallest scale", () => {
    render(<GridHarness />)

    const grid = screen.getByTestId("test-grid")
    expect(screen.queryByRole("slider")).toBeNull()
    expect(grid.getAttribute("data-card-grid-scale")).toBe("1")
    expect(grid.style.gridTemplateColumns).toContain("min(100%, 220px)")
    expect(grid.style.gridAutoRows).toContain("236px")
    expect(screen.getByTestId("item-alpha").getAttribute("data-card-span")).toBe("1x1")
    expect(screen.getByTestId("item-beta").getAttribute("data-card-span")).toBe("1x1")
  })

  test("keeps Dashboard columns bounded and left-aligned without changing Cluster fill", () => {
    const dashboard = render(<GridHarness />)
    const dashboardGrid = screen.getByTestId("test-grid")
    expect(dashboardGrid.style.gridTemplateColumns).toBe(
      "repeat(auto-fill, minmax(min(100%, 220px), 220px))",
    )
    expect(dashboardGrid.style.justifyContent).toBe("start")

    dashboard.unmount()
    render(<GridHarness surface="cluster" />)
    const clusterGrid = screen.getByTestId("test-grid")
    expect(clusterGrid.style.gridTemplateColumns).toBe(
      "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
    )
    expect(clusterGrid.style.justifyContent).toBe("")
  })

  test("an invisible corner drag scales every card progressively and persists one surface value", () => {
    const { unmount } = render(<GridHarness />)
    const handle = firstResizeHandle()
    expect(handle.querySelector("svg")).toBeNull()

    dispatchPointer(handle, "pointerdown", { button: 0, pointerId: 7, clientX: 0, clientY: 0 })
    dispatchPointer(window, "pointermove", { pointerId: 7, clientX: 64, clientY: 64 })

    const grid = screen.getByTestId("test-grid")
    expect(grid.getAttribute("data-card-grid-scale")).toBe("1.2")
    expect(grid.style.gridTemplateColumns).toContain("min(100%, 264px)")
    expect(window.localStorage.getItem("pi-lab.cardGrid.dashboard.scale")).toBe("1.2")
    expect(screen.getByTestId("item-alpha").getAttribute("data-card-span")).toBe("1x1")
    expect(screen.getByTestId("item-beta").getAttribute("data-card-span")).toBe("1x1")

    dispatchPointer(window, "pointerup", { pointerId: 7, clientX: 64, clientY: 64 })
    unmount()
    render(<GridHarness />)
    expect(screen.getByTestId("test-grid").getAttribute("data-card-grid-scale")).toBe("1.2")
  })

  test("a vertical corner drag also resizes the shared Dashboard cards", () => {
    render(<GridHarness />)
    const handle = firstResizeHandle()

    dispatchPointer(handle, "pointerdown", { button: 0, pointerId: 8, clientX: 0, clientY: 0 })
    dispatchPointer(window, "pointermove", { pointerId: 8, clientX: 0, clientY: 128 })

    const grid = screen.getByTestId("test-grid")
    expect(grid.getAttribute("data-card-grid-scale")).toBe("1.2")
    expect(grid.style.gridTemplateColumns).toContain("264px")
    expect(grid.style.gridAutoRows).toContain("283px")
  })

  test("keyboard resizing is smooth, global, accessible, and clamps safely", () => {
    render(<GridHarness />)
    const handle = firstResizeHandle()

    expect(handle.getAttribute("aria-label")).toContain("100 percent")
    fireEvent.keyDown(handle, { key: "ArrowRight" })
    expect(screen.getByTestId("test-grid").getAttribute("data-card-grid-scale")).toBe("1.05")
    expect(handle.getAttribute("aria-label")).toContain("105 percent")

    for (let index = 0; index < 30; index += 1) fireEvent.keyDown(handle, { key: "ArrowLeft" })
    expect(screen.getByTestId("test-grid").getAttribute("data-card-grid-scale")).toBe("0.7")
    expect(screen.getAllByTestId("card-resize-status")[0]?.getAttribute("aria-live")).toBe("polite")
  })

  test("surface scales stay independent", () => {
    const first = render(<GridHarness />)
    fireEvent.keyDown(firstResizeHandle(), { key: "ArrowRight" })
    expect(screen.getByTestId("test-grid").getAttribute("data-card-grid-scale")).toBe("1.05")

    first.unmount()
    render(<GridHarness surface="cluster" />)
    const grid = screen.getByTestId("test-grid")
    expect(grid.getAttribute("data-card-grid-scale")).toBe("1")
    expect(grid.getAttribute("data-card-grid-base-row")).toBe("128")
  })
})
