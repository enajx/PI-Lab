import { useMemo } from "react"
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  ErrorBar,
  Line,
  ReferenceArea,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import type { PlotPreview } from "../../../../../../../../main/trpc/science/analysis"
import { useTranslate } from "../../../../../../../i18n/language"
import {
  inRange,
  rangeOf,
  useChartZoom,
  useWheelZoom,
  xAtPixel,
  zoomMouseHandlers,
} from "../MetricChart/chartZoom"
import { formatChartNumber } from "../MetricChart/formatChartNumber"
import {
  ChartTooltip,
  FALLBACK_WIDTH,
  MAX_LEGEND_SERIES,
  PLOT_MARGIN,
  SELECTION_FILL,
  useChartHeight,
  useMeasuredWidth,
  Y_AXIS_WIDTH,
  ZOOMED_Y_DOMAIN,
} from "../MetricChart/MetricChart"
import { paletteColor } from "../MetricChart/palettes"
import { ZoomControls } from "../MetricChart/ZoomControls"

/**
 * A table plotted by the chart builder ({@link PlotPreview}): lines, points or
 * bars, one per series, with an optional shaded band (lines, points) or error
 * bars (bars) for the spread. Each series has its own x values, so lines and
 * points get their own data; bars share one row per x value.
 *
 * Zoom (drag, +, −, reset, double-click) is view-only. Lines and points zoom
 * the numeric x axis and draw only the points in view; bars are categories,
 * so they keep the rows whose x is in the zoomed range.
 */

const AXIS_TICK = { fontSize: 11, fill: "var(--muted-foreground)" }

export function PlotChart({ plot, palette }: { plot: PlotPreview; palette: string }) {
  const colorFor = (index: number): string => paletteColor(palette, index, plot.series.length)
  const t = useTranslate()
  const { ref, width } = useMeasuredWidth()
  const chartHeight = useChartHeight(ref)
  const categories = plot.xCategories
  const xText = (value: number): string =>
    categories ? (categories[value] ?? "") : formatChartNumber(value)
  const empty = plot.series.every((series) => series.x.length === 0)

  return (
    <div data-testid="analysis-plot" className="flex flex-col gap-2">
      {empty ? (
        <p
          data-testid="analysis-plot-empty"
          className="select-text cursor-text text-muted-foreground text-sm"
        >
          {t("No plottable points with these settings.")}
        </p>
      ) : (
        <div ref={ref} className="relative w-full select-none">
          {plot.chartType === "bar" ? (
            <BarPlot
              plot={plot}
              width={width || FALLBACK_WIDTH}
              height={chartHeight}
              xText={xText}
              colorFor={colorFor}
            />
          ) : (
            <PointPlot
              plot={plot}
              width={width || FALLBACK_WIDTH}
              height={chartHeight}
              xText={xText}
              colorFor={colorFor}
            />
          )}
        </div>
      )}
      {plot.series.length <= MAX_LEGEND_SERIES ? (
        <div
          className="flex flex-wrap justify-end gap-x-4 gap-y-1"
          data-testid="analysis-plot-legend"
        >
          {plot.series.map((series, i) => (
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
      {plot.partial ? (
        <p data-testid="analysis-plot-partial" className="text-right text-muted-foreground text-xs">
          {t("First {count} rows of the file").replace("{count}", plot.rowsUsed.toLocaleString())}
        </p>
      ) : null}
      {plot.notes.map((note) => (
        <p
          key={note}
          data-testid="analysis-plot-note"
          className="text-right text-muted-foreground text-xs"
        >
          {note}
        </p>
      ))}
    </div>
  )
}

/** The hover card: the x value and each series' value at it. */
function PlotTooltip({
  active,
  label,
  payload,
  xLabel,
  xText,
}: {
  active?: boolean
  label?: unknown
  payload?: Array<{ name?: unknown; value?: unknown; color?: unknown; payload?: { x?: number } }>
  xLabel: string
  xText: (value: number) => string
}) {
  const t = useTranslate()
  if (!active || !payload || payload.length === 0) return null
  const x = typeof label === "number" ? label : (payload[0]?.payload?.x ?? 0)
  return (
    <ChartTooltip
      xText={`${xLabel}: ${xText(x)}`}
      entries={payload
        .filter((entry) => typeof entry.value === "number")
        .map((entry) => ({
          name: String(entry.name),
          value: entry.value as number,
          color: String(entry.color),
        }))}
      moreText={(count) => t("+{count} more").replace("{count}", String(count))}
    />
  )
}

/** Lines or points, with a shaded band when the series has one. */
function PointPlot({
  plot,
  colorFor,
  width,
  height,
  xText,
}: {
  plot: PlotPreview
  /** The color of series `index`. */
  colorFor: (index: number) => string
  width: number
  height: number
  xText: (value: number) => string
}) {
  const data = useMemo(
    () =>
      plot.series.map((series) =>
        series.x.map((x, i) => ({
          x,
          y: series.y[i] ?? null,
          band: series.lo && series.hi ? [series.lo[i] ?? 0, series.hi[i] ?? 0] : null,
        })),
      ),
    [plot],
  )
  const categories = plot.xCategories
  const values = useMemo(() => plot.series.flatMap((series) => series.x), [plot])
  const full = useMemo(
    () =>
      categories
        ? { min: -0.5, max: categories.length - 0.5 }
        : (rangeOf(values) ?? { min: 0, max: 0 }),
    [categories, values],
  )
  const zoom = useChartZoom(full, values)
  const view = zoom.view
  // Only the points in view are drawn, so the y axis fits them.
  const shown = useMemo(
    () =>
      zoom.zoomed ? data.map((points) => points.filter((point) => inRange(point.x, view))) : data,
    [data, view, zoom.zoomed],
  )
  const mouse = zoomMouseHandlers(zoom, (state) =>
    xAtPixel(state.chartX ?? 0, PLOT_MARGIN.left + Y_AXIS_WIDTH, width - PLOT_MARGIN.right, view),
  )
  const wheelRef = useWheelZoom(zoom, (px) =>
    xAtPixel(px, PLOT_MARGIN.left + Y_AXIS_WIDTH, width - PLOT_MARGIN.right, view),
  )
  return (
    <>
      <div ref={wheelRef}>
        <ComposedChart width={width} height={height} margin={PLOT_MARGIN} {...mouse}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="x"
            type="number"
            domain={[view.min, view.max]}
            allowDataOverflow
            ticks={
              categories ? categories.map((_, i) => i).filter((i) => inRange(i, view)) : undefined
            }
            allowDuplicatedCategory={false}
            tick={AXIS_TICK}
            tickFormatter={xText}
            label={{
              value: plot.xLabel,
              position: "insideBottom",
              offset: -4,
              style: AXIS_TICK,
            }}
          />
          <YAxis
            width={Y_AXIS_WIDTH}
            {...(zoom.zoomed ? ZOOMED_Y_DOMAIN : {})}
            tick={AXIS_TICK}
            tickFormatter={formatChartNumber}
          />
          <Tooltip
            content={(props) => <PlotTooltip {...props} xLabel={plot.xLabel} xText={xText} />}
          />
          {plot.series.map((series, i) =>
            series.lo ? (
              <Area
                key={`${series.label}-band`}
                data={shown[i]}
                dataKey="band"
                name={`${series.label} band`}
                stroke="none"
                fill={colorFor(i)}
                fillOpacity={0.15}
                isAnimationActive={false}
                legendType="none"
                tooltipType="none"
              />
            ) : null,
          )}
          {plot.series.map((series, i) =>
            plot.chartType === "scatter" ? (
              <Scatter
                key={series.label}
                data={shown[i]}
                dataKey="y"
                name={series.label}
                fill={colorFor(i)}
                isAnimationActive={false}
              />
            ) : (
              <Line
                key={series.label}
                data={shown[i]}
                dataKey="y"
                name={series.label}
                type="linear"
                stroke={colorFor(i)}
                strokeWidth={1.5}
                dot={series.x.length <= 50}
                isAnimationActive={false}
              />
            ),
          )}
          {zoom.selection ? (
            <ReferenceArea
              x1={zoom.selection.min}
              x2={zoom.selection.max}
              fill={SELECTION_FILL}
              fillOpacity={0.15}
            />
          ) : null}
        </ComposedChart>
      </div>
      <ZoomControls zoom={zoom} />
    </>
  )
}

/** Bars, one row per x value, with error bars for the spread. */
function BarPlot({
  plot,
  colorFor,
  width,
  height,
  xText,
}: {
  plot: PlotPreview
  /** The color of series `index`. */
  colorFor: (index: number) => string
  width: number
  height: number
  xText: (value: number) => string
}) {
  const rows = useMemo(() => {
    const byX = new Map<number, Record<string, number | number[] | null>>()
    plot.series.forEach((series, s) => {
      series.x.forEach((x, i) => {
        const row = byX.get(x) ?? { x }
        const y = series.y[i] ?? null
        row[`s${s}`] = y
        if (series.lo && series.hi && y !== null) {
          row[`e${s}`] = [y - (series.lo[i] ?? y), (series.hi[i] ?? y) - y]
        }
        byX.set(x, row)
      })
    })
    return [...byX.values()].sort((a, b) => Number(a.x) - Number(b.x))
  }, [plot])
  const values = useMemo(() => rows.map((row) => Number(row.x)), [rows])
  const full = useMemo(() => rangeOf(values) ?? { min: 0, max: 0 }, [values])
  const zoom = useChartZoom(full, values)
  const view = zoom.view
  const shown = useMemo(
    () => (zoom.zoomed ? rows.filter((row) => inRange(Number(row.x), view)) : rows),
    [rows, view, zoom.zoomed],
  )
  // Bars are categories: the bar under the mouse gives the x value.
  const mouse = zoomMouseHandlers(zoom, (state) => {
    const x = Number(state.activeLabel)
    return state.activeLabel === undefined || Number.isNaN(x) ? null : x
  })
  const wheelRef = useWheelZoom(zoom, (px) =>
    xAtPixel(px, PLOT_MARGIN.left + Y_AXIS_WIDTH, width - PLOT_MARGIN.right, view),
  )
  return (
    <>
      <div ref={wheelRef}>
        <BarChart width={width} height={height} data={shown} margin={PLOT_MARGIN} {...mouse}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="x"
            type="category"
            tick={AXIS_TICK}
            tickFormatter={(value: number) => xText(Number(value))}
            label={{
              value: plot.xLabel,
              position: "insideBottom",
              offset: -4,
              style: AXIS_TICK,
            }}
          />
          <YAxis width={Y_AXIS_WIDTH} tick={AXIS_TICK} tickFormatter={formatChartNumber} />
          <Tooltip
            content={(props) => <PlotTooltip {...props} xLabel={plot.xLabel} xText={xText} />}
          />
          {plot.series.map((series, i) => (
            <Bar
              key={series.label}
              dataKey={`s${i}`}
              name={series.label}
              fill={colorFor(i)}
              isAnimationActive={false}
            >
              {series.lo ? (
                <ErrorBar dataKey={`e${i}`} stroke="var(--foreground)" strokeWidth={1} width={4} />
              ) : null}
            </Bar>
          ))}
          {zoom.selection ? (
            <ReferenceArea
              x1={zoom.selection.min}
              x2={zoom.selection.max}
              fill={SELECTION_FILL}
              fillOpacity={0.15}
            />
          ) : null}
        </BarChart>
      </div>
      <ZoomControls zoom={zoom} />
    </>
  )
}
