import { useMemo } from "react"
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  ErrorBar,
  Line,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import type { PlotPreview } from "../../../../../../../../main/trpc/science/analysis"
import { useTranslate } from "../../../../../../../i18n/language"
import { formatChartNumber } from "../MetricChart/formatChartNumber"
import {
  CHART_HEIGHT,
  ChartTooltip,
  colorFor,
  FALLBACK_WIDTH,
  MAX_LEGEND_SERIES,
  useMeasuredWidth,
} from "../MetricChart/MetricChart"

/**
 * A table plotted by the chart builder ({@link PlotPreview}): lines, points or
 * bars, one per series, with an optional shaded band (lines, points) or error
 * bars (bars) for the spread. Each series has its own x values, so lines and
 * points get their own data; bars share one row per x value.
 */

const AXIS_TICK = { fontSize: 11, fill: "var(--muted-foreground)" }

export function PlotChart({ plot }: { plot: PlotPreview }) {
  const t = useTranslate()
  const { ref, width } = useMeasuredWidth()
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
        <div ref={ref} className="w-full">
          {plot.chartType === "bar" ? (
            <BarPlot plot={plot} width={width || FALLBACK_WIDTH} xText={xText} />
          ) : (
            <PointPlot plot={plot} width={width || FALLBACK_WIDTH} xText={xText} />
          )}
        </div>
      )}
      {plot.series.length <= MAX_LEGEND_SERIES ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1" data-testid="analysis-plot-legend">
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
        <p data-testid="analysis-plot-partial" className="text-amber-500 text-xs">
          {t("The chart uses the first {count} rows; the file has more.").replace(
            "{count}",
            plot.rowsUsed.toLocaleString(),
          )}
        </p>
      ) : null}
      {plot.downsampled ? (
        <p className="text-amber-500 text-xs">
          {t("Chart downsampled — the file has more points than are plotted.")}
        </p>
      ) : null}
      {plot.notes.map((note) => (
        <p key={note} data-testid="analysis-plot-note" className="text-amber-500 text-xs">
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
      xText={`${xLabel} ${xText(x)}`}
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
  width,
  xText,
}: {
  plot: PlotPreview
  width: number
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
  return (
    <ComposedChart
      width={width}
      height={CHART_HEIGHT}
      margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
    >
      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
      <XAxis
        dataKey="x"
        type="number"
        domain={categories ? [-0.5, categories.length - 0.5] : ["dataMin", "dataMax"]}
        ticks={categories ? categories.map((_, i) => i) : undefined}
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
      <YAxis tick={AXIS_TICK} tickFormatter={formatChartNumber} />
      <Tooltip content={(props) => <PlotTooltip {...props} xLabel={plot.xLabel} xText={xText} />} />
      {plot.series.map((series, i) =>
        series.lo ? (
          <Area
            key={`${series.label}-band`}
            data={data[i]}
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
            data={data[i]}
            dataKey="y"
            name={series.label}
            fill={colorFor(i)}
            isAnimationActive={false}
          />
        ) : (
          <Line
            key={series.label}
            data={data[i]}
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
    </ComposedChart>
  )
}

/** Bars, one row per x value, with error bars for the spread. */
function BarPlot({
  plot,
  width,
  xText,
}: {
  plot: PlotPreview
  width: number
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
  return (
    <BarChart
      width={width}
      height={CHART_HEIGHT}
      data={rows}
      margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
    >
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
      <YAxis tick={AXIS_TICK} tickFormatter={formatChartNumber} />
      <Tooltip content={(props) => <PlotTooltip {...props} xLabel={plot.xLabel} xText={xText} />} />
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
    </BarChart>
  )
}
