import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"
import { MetricChart } from "./MetricChart"

type Preview = Parameters<typeof MetricChart>[0]["preview"]

/** A chart preview with `count` series over three points. */
function previewWith(count: number): Preview {
  return {
    type: "chart",
    xLabel: "index",
    x: [0, 1, 2],
    series: Array.from({ length: count }, (_, i) => ({
      label: `series-${i}`,
      values: [i, i + 1, i + 2],
    })),
    truncated: false,
  } as Preview
}

describe("MetricChart legend", () => {
  afterEach(() => cleanup())

  test("renders the legend below the chart, not above it", () => {
    const { container } = render(<MetricChart preview={previewWith(2)} />)
    const legend = screen.getByTestId("analysis-chart-legend")
    const plot = container.querySelector(".recharts-wrapper")
    if (!plot) throw new Error("Expected the chart to render")
    expect(plot.compareDocumentPosition(legend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test("shows the legend for 10 series and hides it for more than 10", () => {
    render(<MetricChart preview={previewWith(10)} />)
    expect(screen.getByTestId("analysis-chart-legend").textContent).toContain("series-9")
    cleanup()
    render(<MetricChart preview={previewWith(11)} />)
    expect(screen.queryByTestId("analysis-chart-legend")).toBeNull()
  })
})

describe("MetricChart tooltip", () => {
  afterEach(() => cleanup())

  test("names the x axis and shows each series value with about 4 significant digits", () => {
    const { container } = render(
      <MetricChart
        preview={
          {
            type: "chart",
            xLabel: "step",
            x: [0, 1, 2],
            series: [
              { label: "loss.train", values: [0.5, 0.045454545454545456, 0.25] },
              { label: "lr", values: [0.000001234, 0.000001234, 0.000001234] },
            ],
            truncated: false,
          } as Preview
        }
      />,
    )
    const plot = container.querySelector(".recharts-wrapper")
    if (!plot) throw new Error("Expected the chart to render")
    // The plot spans x 60..612 of the 640 px fallback width; the middle (336 px) is step 1.
    fireEvent.mouseMove(plot, { clientX: 342, clientY: 100, pageX: 342, pageY: 100 })
    expect(screen.getByTestId("analysis-chart-tooltip-label").textContent).toBe("step 1")
    const items = screen.getAllByTestId("analysis-chart-tooltip-item")
    expect(items.map((item) => item.textContent)).toEqual(["loss.train: 0.04545", "lr: 1.234e-6"])
  })

  test("lists at most 10 series, highest values first, and counts the rest", () => {
    const { container } = render(<MetricChart preview={previewWith(12)} />)
    const plot = container.querySelector(".recharts-wrapper")
    if (!plot) throw new Error("Expected the chart to render")
    fireEvent.mouseMove(plot, { clientX: 342, clientY: 100, pageX: 342, pageY: 100 })
    const items = screen.getAllByTestId("analysis-chart-tooltip-item")
    expect(items).toHaveLength(10)
    expect(items[0]?.textContent).toBe("series-11: 12")
    expect(screen.getByTestId("analysis-chart-tooltip-more").textContent).toBe("+2 more")
  })
})

describe("MetricChart zoom", () => {
  afterEach(() => cleanup())

  /** 201 points, x 0..200. */
  const long = {
    type: "chart",
    xLabel: "step",
    x: Array.from({ length: 201 }, (_, i) => i),
    series: [{ label: "loss", values: Array.from({ length: 201 }, (_, i) => 1 / (i + 1)) }],
    truncated: false,
  } as Preview

  /** The numbers on the x axis ticks. */
  function xTicks(container: HTMLElement): number[] {
    return [
      ...container.querySelectorAll(".recharts-xAxis .recharts-cartesian-axis-tick-value"),
    ].map((tick) => Number(tick.textContent))
  }

  test("+ shows the middle half, - and reset show everything again", () => {
    const { container } = render(<MetricChart preview={long} />)
    expect(Math.max(...xTicks(container))).toBe(200)
    expect(screen.getByTestId("analysis-chart-zoom-reset")).toHaveProperty("disabled", true)
    fireEvent.click(screen.getByTestId("analysis-chart-zoom-in"))
    const zoomed = xTicks(container)
    expect(Math.min(...zoomed)).toBeGreaterThanOrEqual(50)
    expect(Math.max(...zoomed)).toBeLessThanOrEqual(150)
    fireEvent.click(screen.getByTestId("analysis-chart-zoom-out"))
    expect(Math.max(...xTicks(container))).toBe(200)
    fireEvent.click(screen.getByTestId("analysis-chart-zoom-in"))
    fireEvent.click(screen.getByTestId("analysis-chart-zoom-reset"))
    expect(Math.max(...xTicks(container))).toBe(200)
    expect(screen.getByTestId("analysis-chart-zoom-out")).toHaveProperty("disabled", true)
  })

  test("dragging across the chart zooms to that x range; double-click resets", () => {
    const { container } = render(<MetricChart preview={long} />)
    const plot = container.querySelector(".recharts-wrapper")
    if (!plot) throw new Error("Expected the chart to render")
    // The plot spans x 60..612 of the 640 px fallback width: 198 px is step 50, 336 px is step 100.
    fireEvent.mouseDown(plot, { clientX: 198, clientY: 100, pageX: 198, pageY: 100 })
    fireEvent.mouseUp(plot, { clientX: 336, clientY: 100, pageX: 336, pageY: 100 })
    const zoomed = xTicks(container)
    expect(Math.min(...zoomed)).toBeGreaterThanOrEqual(50)
    expect(Math.max(...zoomed)).toBeLessThanOrEqual(100)
    fireEvent.doubleClick(plot)
    expect(Math.max(...xTicks(container))).toBe(200)
  })
})
