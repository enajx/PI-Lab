import { useEffect, useMemo, useRef, useState } from "react"
import { CartesianGrid, Line, LineChart, ReferenceArea, Tooltip, XAxis, YAxis } from "recharts"
import type { ChartPreview } from "../../../../../../../../main/trpc/science/analysis"
import { useTranslate } from "../../../../../../../i18n/language"
import { useAnalysisChartColors } from "../../../../../../../preferences/preferences"
import { inRange, rangeOf, useChartZoom, xAtPixel, zoomMouseHandlers } from "./chartZoom"
import { formatChartNumber } from "./formatChartNumber"
import { paletteColor } from "./palettes"
import { ZoomControls } from "./ZoomControls"

/**
 * Line-chart renderer for a {@link ChartPreview} — a numeric metric log (a
 * monotonic x axis + one or more y series) detected from a CSV/TSV or a 1-D
 * `.npy` array. The preview already carries the chart-ready x + series arrays
 * (sampled/downsampled main-side), so this is a pure projection onto recharts:
 * we transpose the columnar series into per-point rows and draw one `<Line>`
 * each. The series legend is rendered as plain DOM (not recharts' SVG) so it
 * stays meaningful even where the SVG can't measure a size.
 *
 * We measure the container ourselves and give `<LineChart>` an explicit pixel
 * size rather than using recharts' `ResponsiveContainer`, which hard-depends on
 * `ResizeObserver` — absent under jsdom, so it would throw in component tests.
 */

/** Chart height; the width is measured from the container (with a fallback). */
export const CHART_HEIGHT = 288
/** Width used until the container is measured (and where measuring is a no-op). */
export const FALLBACK_WIDTH = 640
/** Space around the plot area; the wider right margin holds the zoom buttons. */
export const PLOT_MARGIN = { top: 8, right: 28, bottom: 8, left: 0 }
/** Y axis width in pixels, fixed so a mouse pixel can be turned into an x value. */
export const Y_AXIS_WIDTH = 60
/** Shading of the x range being dragged over to zoom. */
export const SELECTION_FILL = "var(--muted-foreground)"
/**
 * Y axis domain while zoomed: fit the points in view. Not zoomed, the axis
 * keeps recharts' default, which starts at 0.
 */
export const ZOOMED_Y_DOMAIN = { domain: ["auto", "auto"] as [string, string] }

/** Track an element's content width, updating on resize where supported. */
export function useMeasuredWidth(): { ref: React.RefObject<HTMLDivElement | null>; width: number } {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setWidth(element.clientWidth)
    measure()
    // ResizeObserver is absent under jsdom; degrade to the initial measure.
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return { ref, width }
}

/** Above this many series the legend is hidden: it would take more room than the chart. */
export const MAX_LEGEND_SERIES = 10

/** The tooltip lists at most this many series, highest values first. */
const MAX_TOOLTIP_SERIES = 10

interface TooltipEntry {
  name: string
  value: number | null
  color: string
}

/** Hover card: the x value, then up to MAX_TOOLTIP_SERIES series by value, then "+N more". */
export function ChartTooltip({
  xText,
  entries,
  moreText,
}: {
  xText: string
  entries: TooltipEntry[]
  moreText: (count: number) => string
}) {
  const shown = entries
    .filter((entry) => entry.value !== null)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  const listed = shown.slice(0, MAX_TOOLTIP_SERIES)
  const hidden = shown.length - listed.length
  return (
    <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-popover-foreground text-xs shadow-md">
      <p data-testid="analysis-chart-tooltip-label" className="mb-1 font-medium">
        {xText}
      </p>
      {listed.map((entry) => (
        <p
          key={entry.name}
          data-testid="analysis-chart-tooltip-item"
          style={{ color: entry.color }}
        >
          {`${entry.name}: ${formatChartNumber(entry.value ?? 0)}`}
        </p>
      ))}
      {hidden > 0 ? (
        <p data-testid="analysis-chart-tooltip-more" className="mt-1 text-muted-foreground">
          {moreText(hidden)}
        </p>
      ) : null}
    </div>
  )
}

export function MetricChart({ preview }: { preview: ChartPreview }) {
  const [palette] = useAnalysisChartColors()
  const t = useTranslate()
  const { ref, width } = useMeasuredWidth()

  // Transpose the columnar { x, series[] } payload into recharts' per-point rows
  // keyed by the x value plus each series label.
  const points = useMemo(() => {
    return preview.x.map((x, i) => {
      const point: Record<string, number | null> = { x }
      for (const series of preview.series) point[series.label] = series.values[i] ?? null
      return point
    })
  }, [preview])
  const full = useMemo(() => rangeOf(preview.x) ?? { min: 0, max: 0 }, [preview])
  const zoom = useChartZoom(full, preview.x)
  const view = zoom.view
  // Only the points in view are drawn, so the y axis fits them.
  const shown = useMemo(
    () => (zoom.zoomed ? points.filter((point) => inRange(point.x ?? Number.NaN, view)) : points),
    [points, view, zoom.zoomed],
  )
  const chartWidth = width || FALLBACK_WIDTH
  const mouse = zoomMouseHandlers(zoom, (state) =>
    xAtPixel(
      state.chartX ?? 0,
      PLOT_MARGIN.left + Y_AXIS_WIDTH,
      chartWidth - PLOT_MARGIN.right,
      view,
    ),
  )

  if (points.length === 0) {
    return (
      <p
        data-testid="analysis-preview-chart-empty"
        className="select-text cursor-text text-muted-foreground text-sm"
      >
        {t("No plottable points in this file.")}
      </p>
    )
  }

  return (
    <div data-testid="analysis-preview-chart" className="flex flex-col gap-2">
      <div ref={ref} className="relative w-full select-none">
        <LineChart
          width={chartWidth}
          height={CHART_HEIGHT}
          data={shown}
          margin={PLOT_MARGIN}
          {...mouse}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="x"
            type="number"
            domain={[view.min, view.max]}
            allowDataOverflow
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickFormatter={formatChartNumber}
            label={{
              value: preview.xLabel,
              position: "insideBottom",
              offset: -4,
              style: { fontSize: 11, fill: "var(--muted-foreground)" },
            }}
          />
          <YAxis
            width={Y_AXIS_WIDTH}
            {...(zoom.zoomed ? ZOOMED_Y_DOMAIN : {})}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickFormatter={formatChartNumber}
          />
          <Tooltip
            content={({ active, label, payload }) =>
              active && payload && payload.length > 0 ? (
                <ChartTooltip
                  xText={`${preview.xLabel} ${formatChartNumber(Number(label))}`}
                  entries={payload.map((entry) => ({
                    name: String(entry.name),
                    value: typeof entry.value === "number" ? entry.value : null,
                    color: String(entry.color),
                  }))}
                  moreText={(count) => t("+{count} more").replace("{count}", String(count))}
                />
              ) : null
            }
          />
          {preview.series.map((series, i) => (
            <Line
              key={series.label}
              type="monotone"
              dataKey={series.label}
              stroke={paletteColor(palette, i, preview.series.length)}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          ))}
          {zoom.selection ? (
            <ReferenceArea
              x1={zoom.selection.min}
              x2={zoom.selection.max}
              fill={SELECTION_FILL}
              fillOpacity={0.15}
            />
          ) : null}
        </LineChart>
        <ZoomControls zoom={zoom} />
      </div>
      {preview.series.length <= MAX_LEGEND_SERIES ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1" data-testid="analysis-chart-legend">
          {preview.series.map((series, i) => (
            <span key={series.label} className="flex items-center gap-1.5 text-xs">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: paletteColor(palette, i, preview.series.length) }}
              />
              <span className="text-muted-foreground">{series.label}</span>
            </span>
          ))}
        </div>
      ) : null}
      {preview.truncated ? (
        <p className="text-amber-500 text-xs">
          {t("Chart downsampled — the file has more points than are plotted.")}
        </p>
      ) : null}
    </div>
  )
}
