import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"
import { PlotChart } from "./PlotChart"

type Plot = Parameters<typeof PlotChart>[0]["plot"]

/** One series with x 0..count-1, as `chartType`. */
function plotWith(chartType: Plot["chartType"], count: number): Plot {
  return {
    type: "plot",
    chartType,
    xLabel: "step",
    xCategories: null,
    series: [
      {
        label: "loss",
        x: Array.from({ length: count }, (_, i) => i),
        y: Array.from({ length: count }, (_, i) => 1 / (i + 1)),
        lo: null,
        hi: null,
      },
    ],
    rowsUsed: count,
    partial: false,
    downsampled: false,
    notes: [],
  }
}

/** The numbers on the x axis ticks. */
function xTicks(container: HTMLElement): number[] {
  return [...container.querySelectorAll(".recharts-xAxis .recharts-cartesian-axis-tick-value")].map(
    (tick) => Number(tick.textContent),
  )
}

describe("PlotChart zoom", () => {
  afterEach(() => cleanup())

  test("a line chart zooms its x axis with +, - and a drag", () => {
    const { container } = render(<PlotChart plot={plotWith("line", 201)} />)
    expect(Math.max(...xTicks(container))).toBe(200)
    fireEvent.click(screen.getByTestId("analysis-chart-zoom-in"))
    expect(Math.min(...xTicks(container))).toBeGreaterThanOrEqual(50)
    expect(Math.max(...xTicks(container))).toBeLessThanOrEqual(150)
    fireEvent.click(screen.getByTestId("analysis-chart-zoom-out"))
    expect(Math.max(...xTicks(container))).toBe(200)
    const plot = container.querySelector(".recharts-wrapper")
    if (!plot) throw new Error("Expected the chart to render")
    // The plot spans x 60..612 of the 640 px fallback width: 198 px is 50, 336 px is 100.
    fireEvent.mouseDown(plot, { clientX: 198, clientY: 100, pageX: 198, pageY: 100 })
    fireEvent.mouseUp(plot, { clientX: 336, clientY: 100, pageX: 336, pageY: 100 })
    expect(Math.min(...xTicks(container))).toBeGreaterThanOrEqual(50)
    expect(Math.max(...xTicks(container))).toBeLessThanOrEqual(100)
    fireEvent.doubleClick(plot)
    expect(Math.max(...xTicks(container))).toBe(200)
  })

  test("a bar chart keeps the bars whose x is in the zoomed range", () => {
    const { container } = render(<PlotChart plot={plotWith("bar", 9)} />)
    expect(xTicks(container)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    fireEvent.click(screen.getByTestId("analysis-chart-zoom-in"))
    expect(xTicks(container)).toEqual([2, 3, 4, 5, 6])
    fireEvent.click(screen.getByTestId("analysis-chart-zoom-reset"))
    expect(xTicks(container)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })

  test("dragging over bars keeps the bars from the first to the last one dragged over", () => {
    const { container } = render(<PlotChart plot={plotWith("bar", 9)} />)
    const plot = container.querySelector(".recharts-wrapper")
    if (!plot) throw new Error("Expected the chart to render")
    // Nine bars share 60..612 px, about 61 px each: 152 px is bar 1, 336 px is bar 4.
    fireEvent.mouseDown(plot, { clientX: 152, clientY: 100, pageX: 152, pageY: 100 })
    fireEvent.mouseUp(plot, { clientX: 336, clientY: 100, pageX: 336, pageY: 100 })
    expect(xTicks(container)).toEqual([1, 2, 3, 4])
  })
})
