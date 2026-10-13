import { useEffect, useMemo, useRef, useState } from "react"
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts"
import type { ChartPreview } from "../../../../../../../../main/trpc/science/analysis"
import { useTranslate } from "../../../../../../../i18n/language"

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
            label={{
              value: preview.xLabel,
              position: "insideBottom",
              offset: -4,
              style: { fontSize: 11, fill: "var(--muted-foreground)" },
            }}
          />
          <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} />
          <Tooltip
            contentStyle={{
              background: "var(--popover)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
              color: "var(--popover-foreground)",
            }}
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
      {preview.truncated ? (
        <p className="text-amber-500 text-xs">
          {t("Chart downsampled — the file has more points than are plotted.")}
        </p>
      ) : null}
    </div>
  )
}
