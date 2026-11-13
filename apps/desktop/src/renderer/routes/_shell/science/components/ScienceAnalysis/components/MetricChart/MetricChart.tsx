import { useEffect, useMemo, useRef, useState } from "react"
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts"
import type { ChartPreview } from "../../../../../../../../main/trpc/science/analysis"
import { useTranslate } from "../../../../../../../i18n/language"
import { formatChartNumber } from "./formatChartNumber"

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
const CHART_HEIGHT = 288
/** Width used until the container is measured (and where measuring is a no-op). */
const FALLBACK_WIDTH = 640

/** Per-series stroke palette in OKLCH so it reads on both light and dark themes. */
const SERIES_COLORS = [
  "oklch(0.65 0.18 250)",
  "oklch(0.65 0.18 30)",
  "oklch(0.65 0.18 140)",
  "oklch(0.65 0.18 300)",
  "oklch(0.65 0.18 60)",
  "oklch(0.65 0.18 180)",
  "oklch(0.65 0.18 0)",
  "oklch(0.65 0.18 210)",
] as const

function colorFor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length] ?? SERIES_COLORS[0]
}

/** Track an element's content width, updating on resize where supported. */
function useMeasuredWidth(): { ref: React.RefObject<HTMLDivElement | null>; width: number } {
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
const MAX_LEGEND_SERIES = 10

/** The tooltip lists at most this many series, highest values first. */
const MAX_TOOLTIP_SERIES = 10

interface TooltipEntry {
  name: string
  value: number | null
  color: string
}

/** Hover card: the x value, then up to MAX_TOOLTIP_SERIES series by value, then "+N more". */
function ChartTooltip({
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
      <div ref={ref} className="w-full">
        <LineChart
          width={width || FALLBACK_WIDTH}
          height={CHART_HEIGHT}
          data={points}
          margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="x"
            type="number"
            domain={["dataMin", "dataMax"]}
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
              stroke={colorFor(i)}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </LineChart>
      </div>
      {preview.series.length <= MAX_LEGEND_SERIES ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1" data-testid="analysis-chart-legend">
          {preview.series.map((series, i) => (
            <span key={series.label} className="flex items-center gap-1.5 text-xs">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: colorFor(i) }}
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
