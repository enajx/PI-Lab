import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Settings2 } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import type {
  ChartAggregate,
  ChartBand,
  ChartSpec,
  ChartType,
  ColumnInfo,
  TablePreview,
} from "../../../../../../../../main/trpc/science/analysis"
import { useTranslate } from "../../../../../../../i18n/language"
import { useTRPC } from "../../../../../../../trpc/react"
import { PlotChart } from "./PlotChart"

/**
 * A table file in Analysis: a `Table | Chart` switch and, in Chart view, a
 * "Chart settings" popover (chart type, x, y columns, split by, aggregation,
 * spread band). The view and settings are saved for the file's name in the
 * project (`science.analysis.setChartSettings`), so every file with that name
 * opens the same way. A table opens in its default view
 * ({@link TablePreview.defaultView}) until the user changes something.
 */

interface Settings {
  view: "table" | "chart"
  spec: ChartSpec | null
}

/** Whether every column a spec names exists in the table with a usable kind. */
function specFits(spec: ChartSpec, columns: ColumnInfo[]): boolean {
  const byName = new Map(columns.map((c) => [c.name, c]))
  return (
    byName.has(spec.x) &&
    spec.y.every((name) => {
      const column = byName.get(name)
      return column !== undefined && column.kind !== "text"
    }) &&
    (spec.splitBy === null || byName.has(spec.splitBy))
  )
}

export function TableChart({
  projectId,
  relPath,
  dataset,
  preview,
  renderTable,
}: {
  projectId: string
  relPath: string
  /** The HDF5 dataset holding the table, or null. */
  dataset: string | null
  preview: TablePreview
  /** The table view. */
  renderTable: () => ReactNode
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const savedQuery = useQuery(
    trpc.science.analysis.chartSettings.queryOptions({ projectId, relPath }),
  )
  const save = useMutation(
    trpc.science.analysis.setChartSettings.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: trpc.science.analysis.chartSettings.queryKey(),
        }),
    }),
  )
  // Changes made on this file (and HDF5 dataset), until it is left.
  const shownKey = `${relPath}\u0000${dataset ?? ""}`
  const [local, setLocal] = useState<{ key: string; settings: Settings } | null>(null)

  if (savedQuery.isLoading) {
    return <p className="text-muted-foreground text-sm">{t("Loading preview…")}</p>
  }
  const saved = savedQuery.data ?? null
  const savedFits = saved !== null && specFits(saved.spec, preview.columns)
  const settings: Settings =
    local?.key === shownKey
      ? local.settings
      : savedFits
        ? saved
        : { view: preview.defaultView, spec: preview.defaultSpec }
  const mismatch = saved !== null && !savedFits && local?.key !== shownKey
  const fileName = relPath.slice(relPath.lastIndexOf("/") + 1)

  const change = (next: Settings): void => {
    setLocal({ key: shownKey, settings: next })
    if (next.spec) {
      save.mutate({ projectId, relPath, settings: { view: next.view, spec: next.spec } })
    }
  }
  // Back to the automatic chart settings, staying in Chart view.
  const reset = (): void => change({ view: "chart", spec: preview.defaultSpec })

  return (
    <div data-testid="analysis-table-chart" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label={t("View")}
          className="inline-flex rounded-md border border-border p-0.5 text-xs"
        >
          {(["table", "chart"] as const).map((view) => (
            <button
              key={view}
              type="button"
              role="tab"
              data-testid={`analysis-view-${view}`}
              aria-selected={settings.view === view}
              disabled={view === "chart" && settings.spec === null}
              title={
                view === "chart" && settings.spec === null
                  ? t("This table has no numeric column to plot")
                  : undefined
              }
              data-feature-label={view === "table" ? t("Table") : t("Chart")}
              data-feature-help={
                view === "table"
                  ? t("Show the file's first rows as a table")
                  : t(
                      "Plot the table. The choice is kept for every file with this name in the project",
                    )
              }
              onClick={() => change({ ...settings, view })}
              className={
                settings.view === view
                  ? "rounded bg-accent px-2 py-0.5 text-foreground"
                  : "rounded px-2 py-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-50"
              }
            >
              {view === "table" ? t("Table") : t("Chart")}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {settings.view === "chart" && settings.spec ? (
          <ChartSettingsButton
            spec={settings.spec}
            columns={preview.columns}
            onChange={(spec) => change({ ...settings, spec })}
            onReset={reset}
          />
        ) : null}
      </div>
      {save.isError ? (
        <p className="text-destructive text-xs">
          {`${t("Could not save the chart settings:")} ${save.error.message}`}
        </p>
      ) : null}
      {mismatch ? (
        <p data-testid="analysis-chart-settings-mismatch" className="text-amber-500 text-xs">
          {t(
            "The saved chart settings for {name} name columns this file does not have; showing the default view.",
          ).replace("{name}", fileName)}
        </p>
      ) : null}
      {settings.view === "chart" && settings.spec ? (
        <ChartView projectId={projectId} relPath={relPath} dataset={dataset} spec={settings.spec} />
      ) : (
        renderTable()
      )}
    </div>
  )
}

function ChartView({
  projectId,
  relPath,
  dataset,
  spec,
}: {
  projectId: string
  relPath: string
  dataset: string | null
  spec: ChartSpec
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const plot = useQuery({
    ...trpc.science.analysis.chart.queryOptions({ projectId, relPath, dataset, spec }),
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  })
  if (plot.isError) {
    return (
      <p
        data-testid="analysis-plot-error"
        className="select-text cursor-text text-destructive text-sm"
      >
        {`${t("Could not draw the chart:")} ${plot.error.message}`}
      </p>
    )
  }
  if (!plot.data) return <p className="text-muted-foreground text-sm">{t("Drawing chart…")}</p>
  return <PlotChart plot={plot.data} />
}

const CHART_TYPES: Array<{ value: ChartType; label: string }> = [
  { value: "line", label: "Line" },
  { value: "scatter", label: "Scatter" },
  { value: "bar", label: "Bar" },
]
const AGGREGATES: Array<{ value: ChartAggregate; label: string }> = [
  { value: "none", label: "None (every row)" },
  { value: "mean", label: "Mean" },
  { value: "median", label: "Median" },
  { value: "sum", label: "Sum" },
  { value: "count", label: "Count" },
]
const BANDS: Array<{ value: ChartBand; label: string }> = [
  { value: "none", label: "None" },
  { value: "minmax", label: "Min to max" },
  { value: "std", label: "± 1 std" },
  { value: "ci95", label: "95% CI of the mean" },
]
const ROLE_LABELS: Record<ColumnInfo["role"], string> = {
  step: "step",
  factor: "factor",
  measure: "measure",
  text: "text",
  index: "index",
}

/** The "Chart settings" button and its popover. */
function ChartSettingsButton({
  spec,
  columns,
  onChange,
  onReset,
}: {
  spec: ChartSpec
  columns: ColumnInfo[]
  onChange: (spec: ChartSpec) => void
  onReset: () => void
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener("pointerdown", onPointer)
    document.addEventListener("keydown", onKey, true)
    return () => {
      document.removeEventListener("pointerdown", onPointer)
      document.removeEventListener("keydown", onKey, true)
    }
  }, [open])

  const plottable = columns.filter((c) => c.kind !== "text" && c.name !== spec.x)
  const splittable = columns.filter(
    (c) => (c.role === "factor" || c.role === "text") && c.name !== spec.x,
  )
  const bandAllowed = spec.aggregate === "mean" || spec.aggregate === "median"
  const columnLabel = (c: ColumnInfo): string => `${c.name} (${t(ROLE_LABELS[c.role])})`

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        data-testid="analysis-chart-settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-feature-label={t("Chart settings")}
        data-feature-help={t(
          "Choose the x and y columns, a column to split lines by, the chart type, how rows with the same x are combined, and the spread band",
        )}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent/60"
      >
        <Settings2 className="size-3.5" aria-hidden />
        {t("Chart settings")}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t("Chart settings")}
          data-testid="analysis-chart-settings-panel"
          className="absolute top-full right-0 z-20 mt-1 flex w-72 flex-col gap-3 rounded-lg border border-border bg-popover p-3 text-popover-foreground text-xs shadow-lg"
        >
          <Field label={t("Chart type")}>
            <select
              data-testid="analysis-chart-type"
              value={spec.chartType}
              onChange={(event) =>
                onChange({ ...spec, chartType: event.target.value as ChartType })
              }
              className="w-full rounded-md border border-border bg-background px-2 py-1"
            >
              {CHART_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.label)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("X axis")}>
            <select
              data-testid="analysis-chart-x"
              value={spec.x}
              onChange={(event) => {
                const x = event.target.value
                const y = spec.y.filter((name) => name !== x)
                const fallback = columns.find((c) => c.kind !== "text" && c.name !== x)
                onChange({
                  ...spec,
                  x,
                  y: y.length > 0 ? y : fallback ? [fallback.name] : spec.y,
                  splitBy: spec.splitBy === x ? null : spec.splitBy,
                })
              }}
              className="w-full rounded-md border border-border bg-background px-2 py-1"
            >
              {columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {columnLabel(c)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("Y axis")}>
            <div
              data-testid="analysis-chart-y"
              className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border border-border p-1.5"
            >
              {plottable.map((c) => {
                const checked = spec.y.includes(c.name)
                return (
                  <label key={c.name} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={checked}
                      // At least one y column stays ticked.
                      disabled={checked && spec.y.length === 1}
                      onChange={() =>
                        onChange({
                          ...spec,
                          y: checked
                            ? spec.y.filter((name) => name !== c.name)
                            : columns
                                .map((col) => col.name)
                                .filter((name) => name === c.name || spec.y.includes(name)),
                        })
                      }
                    />
                    <span className="truncate">{columnLabel(c)}</span>
                  </label>
                )
              })}
            </div>
          </Field>
          <Field label={t("Split by")}>
            <select
              data-testid="analysis-chart-split"
              value={spec.splitBy ?? ""}
              onChange={(event) =>
                onChange({
                  ...spec,
                  splitBy: event.target.value === "" ? null : event.target.value,
                })
              }
              className="w-full rounded-md border border-border bg-background px-2 py-1"
            >
              <option value="">{t("None")}</option>
              {splittable.map((c) => (
                <option key={c.name} value={c.name}>
                  {columnLabel(c)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("Combine rows with the same x")}>
            <select
              data-testid="analysis-chart-aggregate"
              value={spec.aggregate}
              onChange={(event) => {
                const aggregate = event.target.value as ChartAggregate
                const keepsBand = aggregate === "mean" || aggregate === "median"
                onChange({ ...spec, aggregate, band: keepsBand ? spec.band : "none" })
              }}
              className="w-full rounded-md border border-border bg-background px-2 py-1"
            >
              {AGGREGATES.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.label)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("Spread")}>
            <select
              data-testid="analysis-chart-band"
              value={bandAllowed ? spec.band : "none"}
              disabled={!bandAllowed}
              title={bandAllowed ? undefined : t("The spread band needs mean or median.")}
              onChange={(event) => onChange({ ...spec, band: event.target.value as ChartBand })}
              className="w-full rounded-md border border-border bg-background px-2 py-1 disabled:opacity-50"
            >
              {BANDS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.label)}
                </option>
              ))}
            </select>
          </Field>
          <button
            type="button"
            data-testid="analysis-chart-reset"
            onClick={() => {
              setOpen(false)
              onReset()
            }}
            className="self-start rounded-md border border-border px-2 py-0.5 hover:bg-accent/60"
          >
            {t("Reset to default")}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}
