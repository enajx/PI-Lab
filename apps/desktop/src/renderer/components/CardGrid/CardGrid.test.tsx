import { readFileSync } from "node:fs"
import { resolve } from "node:path"
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

/** Start the Dashboard grid at the 100% base size, so drag and key steps read from 1. */
function startDashboardAtBase(): void {
  window.localStorage.setItem(
    "pi-lab.cardGrid.dashboard.size",
    JSON.stringify({ width: 1, height: 1 }),
  )
}

describe("CardGrid", () => {
  beforeEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  test("defaults every card to one shared base width and height", () => {
    render(<GridHarness />)

    const grid = screen.getByTestId("test-grid")
    expect(screen.queryByRole("slider")).toBeNull()
    expect(grid.getAttribute("data-card-grid-width")).toBe("0.9")
    expect(grid.getAttribute("data-card-grid-height")).toBe("1")
    expect(grid.style.gridTemplateColumns).toContain("min(100%, 198px)")
    expect(grid.style.gridAutoRows).toContain("236px")
    expect(screen.getByTestId("item-alpha").getAttribute("data-card-span")).toBe("1x1")
    expect(screen.getByTestId("item-beta").getAttribute("data-card-span")).toBe("1x1")
  })

  test("keeps Dashboard columns bounded and left-aligned without changing Cluster fill", () => {
    const dashboard = render(<GridHarness />)
    const dashboardGrid = screen.getByTestId("test-grid")
    expect(dashboardGrid.style.gridTemplateColumns).toBe(
      "repeat(auto-fill, minmax(min(100%, 198px), 198px))",
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

  test("a corner drag changes width and height separately in 10% steps and persists them", () => {
    startDashboardAtBase()
    const { unmount } = render(<GridHarness />)
    const handle = firstResizeHandle()
    expect(handle.querySelector("svg")).toBeNull()
    const grid = screen.getByTestId("test-grid")

    // 30px right is 13.6% of the 220px base width, which snaps to +10%.
    dispatchPointer(handle, "pointerdown", { button: 0, pointerId: 7, clientX: 0, clientY: 0 })
    dispatchPointer(window, "pointermove", { pointerId: 7, clientX: 30, clientY: 0 })
    expect(grid.getAttribute("data-card-grid-width")).toBe("1.1")
    expect(grid.getAttribute("data-card-grid-height")).toBe("1")
    expect(grid.style.gridTemplateColumns).toContain("min(100%, 242px)")
    expect(grid.style.gridAutoRows).toContain("236px")

    // 10px more right stays in the same step; 50px down is +21% of 236px, so +20% height.
    dispatchPointer(window, "pointermove", { pointerId: 7, clientX: 40, clientY: 50 })
    expect(grid.getAttribute("data-card-grid-width")).toBe("1.2")
    expect(grid.getAttribute("data-card-grid-height")).toBe("1.2")
    dispatchPointer(window, "pointermove", { pointerId: 7, clientX: 30, clientY: 50 })
    expect(grid.getAttribute("data-card-grid-width")).toBe("1.1")
    expect(grid.getAttribute("data-card-grid-height")).toBe("1.2")
    expect(grid.style.gridAutoRows).toContain("283px")
    expect(screen.getByTestId("item-alpha").getAttribute("data-card-span")).toBe("1x1")
    expect(screen.getByTestId("item-beta").getAttribute("data-card-span")).toBe("1x1")

    dispatchPointer(window, "pointerup", { pointerId: 7, clientX: 30, clientY: 50 })
    unmount()
    render(<GridHarness />)
    const restored = screen.getByTestId("test-grid")
    expect(restored.getAttribute("data-card-grid-width")).toBe("1.1")
    expect(restored.getAttribute("data-card-grid-height")).toBe("1.2")
  })

  test("a drag clamps each axis to 70%-160% and cancel restores the start size", () => {
    startDashboardAtBase()
    render(<GridHarness />)
    const handle = firstResizeHandle()
    const grid = screen.getByTestId("test-grid")

    dispatchPointer(handle, "pointerdown", { button: 0, pointerId: 8, clientX: 0, clientY: 0 })
    dispatchPointer(window, "pointermove", { pointerId: 8, clientX: 1000, clientY: -1000 })
    expect(grid.getAttribute("data-card-grid-width")).toBe("1.6")
    expect(grid.getAttribute("data-card-grid-height")).toBe("0.7")
    dispatchPointer(window, "pointercancel", { pointerId: 8, clientX: 1000, clientY: -1000 })
    expect(grid.getAttribute("data-card-grid-width")).toBe("1")
    expect(grid.getAttribute("data-card-grid-height")).toBe("1")
  })

  test("migrates the old single scale value to both width and height", () => {
    window.localStorage.setItem("pi-lab.cardGrid.dashboard.scale", "1.25")
    render(<GridHarness />)

    const grid = screen.getByTestId("test-grid")
    expect(grid.getAttribute("data-card-grid-width")).toBe("1.3")
    expect(grid.getAttribute("data-card-grid-height")).toBe("1.3")
    expect(window.localStorage.getItem("pi-lab.cardGrid.dashboard.scale")).toBeNull()
    expect(window.localStorage.getItem("pi-lab.cardGrid.dashboard.size")).toBe(
      JSON.stringify({ width: 1.3, height: 1.3 }),
    )
  })

  test("the cards animate a size snap with a short transition", () => {
    render(<GridHarness />)
    const item = screen.getByTestId("item-alpha")
    expect(item.className).toContain("card-grid-item")
    const css = readFileSync(resolve(__dirname, "cardGrid.css"), "utf8")
    expect(css).toMatch(/\.card-grid-item\s*\{[^}]*transition:[^}]*ms/)
  })

  test("Arabic uses the lower-left resize corner and mirrored horizontal controls", () => {
    document.documentElement.dir = "rtl"
    startDashboardAtBase()
    render(<GridHarness />)
    const handle = firstResizeHandle()
    expect(handle.className).toContain("rtl:left-0")
    const grid = screen.getByTestId("test-grid")
    dispatchPointer(handle, "pointerdown", { pointerId: 9, clientX: 100, clientY: 0 })
    dispatchPointer(window, "pointermove", { pointerId: 9, clientX: 56, clientY: 0 })
    expect(grid.getAttribute("data-card-grid-width")).toBe("1.2")
    dispatchPointer(window, "pointerup", { pointerId: 9, clientX: 56, clientY: 0 })
    fireEvent.keyDown(handle, { key: "ArrowLeft" })
    expect(grid.getAttribute("data-card-grid-width")).toBe("1.3")
    expect(grid.getAttribute("data-card-grid-height")).toBe("1")
    document.documentElement.dir = "ltr"
  })

  test("keyboard resizing steps 10%: left/right change width, up/down change height", () => {
    startDashboardAtBase()
    render(<GridHarness />)
    const handle = firstResizeHandle()
    const grid = screen.getByTestId("test-grid")

    expect(handle.getAttribute("aria-label")).toContain("width 100 percent, height 100 percent")
    fireEvent.keyDown(handle, { key: "ArrowRight" })
    expect(grid.getAttribute("data-card-grid-width")).toBe("1.1")
    expect(grid.getAttribute("data-card-grid-height")).toBe("1")
    expect(handle.getAttribute("aria-label")).toContain("width 110 percent")
    fireEvent.keyDown(handle, { key: "ArrowDown" })
    expect(grid.getAttribute("data-card-grid-height")).toBe("1.1")
    fireEvent.keyDown(handle, { key: "ArrowUp" })
    fireEvent.keyDown(handle, { key: "ArrowUp" })
    expect(grid.getAttribute("data-card-grid-height")).toBe("0.9")

    for (let index = 0; index < 30; index += 1) fireEvent.keyDown(handle, { key: "ArrowLeft" })
    expect(grid.getAttribute("data-card-grid-width")).toBe("0.7")
    // Home returns to the Dashboard default: one 10% step narrower than the base width.
    fireEvent.keyDown(handle, { key: "Home" })
    expect(grid.getAttribute("data-card-grid-width")).toBe("0.9")
    expect(grid.getAttribute("data-card-grid-height")).toBe("1")
    expect(screen.getAllByTestId("card-resize-status")[0]?.getAttribute("aria-live")).toBe("polite")
  })

  test("surface sizes stay independent", () => {
    startDashboardAtBase()
    const first = render(<GridHarness />)
    fireEvent.keyDown(firstResizeHandle(), { key: "ArrowRight" })
    expect(screen.getByTestId("test-grid").getAttribute("data-card-grid-width")).toBe("1.1")

    first.unmount()
    render(<GridHarness surface="cluster" />)
    const grid = screen.getByTestId("test-grid")
    expect(grid.getAttribute("data-card-grid-width")).toBe("1")
    expect(grid.getAttribute("data-card-grid-base-row")).toBe("128")
  })
})
