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
    // The plot spans x 60..624 of the 640 px fallback width; the middle is step 1.
    fireEvent.mouseMove(plot, { clientX: 342, clientY: 100, pageX: 342, pageY: 100 })
    const tooltip = container.querySelector(".recharts-tooltip-wrapper")
    expect(tooltip?.querySelector(".recharts-tooltip-label")?.textContent).toBe("step 1")
    const items = [...(tooltip?.querySelectorAll(".recharts-tooltip-item") ?? [])]
    expect(items.map((item) => item.textContent)).toEqual(["loss.train : 0.04545", "lr : 1.234e-6"])
  })
})
