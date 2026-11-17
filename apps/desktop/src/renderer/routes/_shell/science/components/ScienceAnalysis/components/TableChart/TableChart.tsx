import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Download } from "lucide-react"
import { useState } from "react"
import type {
  Aggregation,
  ChartSpec,
  ColumnInfo,
  TableOps,
  TablePage,
  TablePreview,
} from "../../../../../../../../main/trpc/science/analysis"
import { useTranslate } from "../../../../../../../i18n/language"
import { useTRPC } from "../../../../../../../trpc/react"
import { AggregateSettings } from "./AggregateSettings"
import { ChartSettings } from "./ChartSettings"
import { DataTable } from "./DataTable"
import { PlotChart } from "./PlotChart"
import { orderedColumns, type TableDisplay, TableSettings } from "./TableSettings"

/**
 * A table file in Analysis: a `Table | Chart` switch, the Aggregate, Table
 * settings and Chart settings popovers, and Export CSV. The operations run in
 * a fixed order (filters, then one aggregation, then the sort) on the first
 * rows read; the table scrolls through the result and the chart plots it. The
 * view, operations, display and chart settings are saved for the file's name in
 * the project (`science.analysis.setTableSettings`), so every file with that
 * name opens the same way. A table opens in its default view
 * ({@link TablePreview.defaultView}) until the user changes something.
 */

interface Settings {
  view: "table" | "chart"
  spec: ChartSpec | null
  ops: TableOps
  display: TableDisplay
}

const NO_OPS: TableOps = { filters: [], aggregation: null, sort: [] }
const PLAIN_DISPLAY: TableDisplay = { hidden: [], order: [], decimals: null, scientific: false }
/** Rows in the first page (the rest load as the table scrolls). */
const FIRST_PAGE_ROWS = 200

/** Whether every column a spec names exists with a usable kind. */
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

/**
 * Whether every column the operations name exists: filters and the
 * aggregation name the file's columns, the sort names the result's columns
 * (known here for every aggregation but a pivot, whose columns come from values).
 */
function opsFit(ops: TableOps, columns: ColumnInfo[]): boolean {
  const names = columns.map((c) => c.name)
  const has = (name: string) => names.includes(name)
  const a = ops.aggregation
  const aggregated: string[] =
    a === null || a.kind === "describe"
      ? []
      : a.kind === "groupBy"
        ? [...a.by, ...a.values.map((v) => v.column)]
        : a.kind === "pivot"
          ? [a.index, a.columns, a.values]
          : a.columns
  const resultNames: string[] | null =
    a === null
      ? names
      : a.kind === "groupBy"
        ? [...a.by, ...a.values.map((v) => `${v.column} (${v.fn})`)]
        : a.kind === "describe"
          ? ["statistic", ...names]
          : a.kind === "valueCounts"
            ? [...a.columns, "count"]
            : null
  return (
    ops.filters.every((f) => has(f.column)) &&
    aggregated.every(has) &&
    (resultNames === null || ops.sort.every((key) => resultNames.includes(key.column)))
  )
}

/** The suggested export file name, e.g. `options.grouped.csv`. */
function exportName(relPath: string, ops: TableOps): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "")
  const kind = ops.aggregation?.kind
  const suffix =
    kind === "groupBy"
      ? "grouped"
      : kind === "pivot"
        ? "pivot"
        : kind === "describe"
          ? "describe"
          : kind === "valueCounts"
            ? "value-counts"
            : ops.filters.length > 0
              ? "filtered"
              : ops.sort.length > 0
                ? "sorted"
                : "copy"
  return `${base}.${suffix}.csv`
}

/** A short line of what the operations do, e.g. "2 filters · Group by question". */
function useOpsSummary(): (ops: TableOps) => string {
  const t = useTranslate()
  const aggregationText = (a: Aggregation): string =>
    a.kind === "groupBy"
      ? `${t("Group by")} ${a.by.join(", ")}`
      : a.kind === "pivot"
        ? `${t("Pivot")} ${a.index} × ${a.columns}`
        : a.kind === "describe"
          ? t("Describe")
          : `${t("Value counts of")} ${a.columns.join(", ")}`
  return (ops) =>
    [
      ops.filters.length === 1
        ? t("1 filter")
        : ops.filters.length > 1
          ? t("{count} filters").replace("{count}", String(ops.filters.length))
          : "",
      ops.aggregation ? aggregationText(ops.aggregation) : "",
      ops.sort.length > 0
        ? `${t("Sorted by")} ${ops.sort.map((k) => `${k.column} ${k.descending ? "↓" : "↑"}`).join(", ")}`
        : "",
    ]
      .filter((part) => part !== "")
      .join(" · ")
}

export function TableChart({
  projectId,
  projectPath,
  relPath,
  dataset,
  preview,
}: {
  projectId: string
  /** The project's folder, where Export CSV's save dialog opens; null while unknown. */
  projectPath: string | null
  relPath: string
  /** The HDF5 dataset holding the table, or null. */
  dataset: string | null
  preview: TablePreview
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const summary = useOpsSummary()
  const savedQuery = useQuery(
    trpc.science.analysis.tableSettings.queryOptions({ projectId, relPath }),
  )
  const save = useMutation(
    trpc.science.analysis.setTableSettings.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: trpc.science.analysis.tableSettings.queryKey(),
        }),
    }),
  )
  // Changes made on this file (and HDF5 dataset), until it is left.
  const shownKey = `${relPath}\u0000${dataset ?? ""}`
  const [local, setLocal] = useState<{ key: string; settings: Settings } | null>(null)

  const saved = savedQuery.data ?? null
  const savedFits = saved !== null && opsFit(saved.ops, preview.columns)
  const settings: Settings =
    local?.key === shownKey
      ? local.settings
      : savedFits
        ? saved
        : {
            view: preview.defaultView,
            spec: preview.defaultSpec,
            ops: NO_OPS,
            display: PLAIN_DISPLAY,
          }
  const mismatch = saved !== null && !savedFits && local?.key !== shownKey

  const firstPage = useQuery({
    ...trpc.science.analysis.table.queryOptions({
      projectId,
      relPath,
      dataset,
      ops: settings.ops,
      offset: 0,
      limit: FIRST_PAGE_ROWS,
    }),
    enabled: !savedQuery.isLoading,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  })

  if (savedQuery.isLoading) {
    return <p className="text-muted-foreground text-sm">{t("Loading preview…")}</p>
  }
  const page: TablePage | undefined = firstPage.data
  const resultColumns = page?.columns ?? preview.columns
  // The chart follows the result: a saved chart that no longer fits it gives way to the result's default.
  const spec =
    settings.spec && specFits(settings.spec, resultColumns)
      ? settings.spec
      : (page?.defaultSpec ?? null)
  const fileName = relPath.slice(relPath.lastIndexOf("/") + 1)

  const change = (next: Settings): void => {
    setLocal({ key: shownKey, settings: next })
    save.mutate({ projectId, relPath, settings: next })
  }
  const changeOps = (ops: TableOps): void => {
    // Columns of the result change with the aggregation, so their display and sort start over.
    const aggregationChanged =
      JSON.stringify(ops.aggregation) !== JSON.stringify(settings.ops.aggregation)
    change({
      ...settings,
      ops: aggregationChanged ? { ...ops, sort: [] } : ops,
      display: aggregationChanged
        ? { ...settings.display, hidden: [], order: [] }
        : settings.display,
    })
  }
  const resetChart = (): void =>
    change({ ...settings, view: "chart", spec: page?.defaultSpec ?? preview.defaultSpec })

  const headers = page?.headers ?? []
  const shownNames = orderedColumns(headers, settings.display.order).filter(
    (name) => !settings.display.hidden.includes(name),
  )
  const shown = shownNames.map((name) => headers.indexOf(name))
  const opsText = summary(settings.ops)

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
              disabled={view === "chart" && spec === null}
              title={
                view === "chart" && spec === null
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
              onClick={() => change({ ...settings, view, spec })}
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
        <AggregateSettings
          columns={preview.columns}
          aggregation={settings.ops.aggregation}
          onChange={(aggregation) => changeOps({ ...settings.ops, aggregation })}
        />
        <TableSettings
          sourceColumns={preview.columns}
          resultColumns={resultColumns}
          ops={settings.ops}
          display={settings.display}
          onOps={changeOps}
          onDisplay={(display) => change({ ...settings, display })}
        />
        {settings.view === "chart" && spec ? (
          <ChartSettings
            spec={spec}
            columns={resultColumns}
            onChange={(next) => change({ ...settings, spec: next })}
            onReset={resetChart}
          />
        ) : null}
        <ExportButton
          projectId={projectId}
          projectPath={projectPath}
          relPath={relPath}
          dataset={dataset}
          ops={settings.ops}
          columns={shownNames.length > 0 ? shownNames : null}
        />
      </div>
      {opsText !== "" ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span data-testid="analysis-table-ops" className="text-muted-foreground">
            {opsText}
          </span>
          <button
            type="button"
            data-testid="analysis-table-clear-ops"
            onClick={() => changeOps(NO_OPS)}
            className="rounded-md border border-border px-1.5 py-0.5 hover:bg-accent/60"
          >
            {t("Clear")}
          </button>
        </div>
      ) : null}
      {save.isError ? (
        <p className="text-destructive text-xs">
          {`${t("Could not save the table settings:")} ${save.error.message}`}
        </p>
      ) : null}
      {mismatch ? (
        <p data-testid="analysis-chart-settings-mismatch" className="text-amber-500 text-xs">
          {t(
            "The saved settings for {name} name columns this file does not have; showing the default view.",
          ).replace("{name}", fileName)}
        </p>
      ) : null}
      {page?.notes.map((note) => (
        <p key={note} className="text-amber-500 text-xs">
          {note}
        </p>
      ))}
      {firstPage.isError ? (
        <p
          data-testid="analysis-table-error"
          className="select-text cursor-text text-destructive text-sm"
        >
          {firstPage.error.message}
        </p>
      ) : !page ? (
        <p className="text-muted-foreground text-sm">{t("Loading preview…")}</p>
      ) : settings.view === "chart" && spec ? (
        <ChartView
          projectId={projectId}
          relPath={relPath}
          dataset={dataset}
          ops={settings.ops}
          spec={spec}
        />
      ) : (
        <DataTable
          projectId={projectId}
          relPath={relPath}
          dataset={dataset}
          ops={settings.ops}
          firstPage={page}
          updating={firstPage.isPlaceholderData}
          shown={shown}
          format={settings.display}
          onSort={(sort) => change({ ...settings, ops: { ...settings.ops, sort } })}
        />
      )}
    </div>
  )
}

function ChartView({
  projectId,
  relPath,
  dataset,
  ops,
  spec,
}: {
  projectId: string
  relPath: string
  dataset: string | null
  ops: TableOps
  spec: ChartSpec
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const plot = useQuery({
    ...trpc.science.analysis.chart.queryOptions({ projectId, relPath, dataset, ops, spec }),
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

/** Export CSV: a save dialog in the file's folder, then the shown result is written there. */
function ExportButton({
  projectId,
  projectPath,
  relPath,
  dataset,
  ops,
  columns,
}: {
  projectId: string
  projectPath: string | null
  relPath: string
  dataset: string | null
  ops: TableOps
  columns: string[] | null
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const pick = useMutation(trpc.system.pickSaveFile.mutationOptions())
  const write = useMutation(trpc.science.analysis.exportTable.mutationOptions())
  const [done, setDone] = useState<{ path: string; rows: number } | null>(null)
  const folder = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : ""
  const start = (): void => {
    if (!projectPath) return
    setDone(null)
    write.reset()
    const defaultPath = [projectPath, folder, exportName(relPath, ops)]
      .filter((part) => part !== "")
      .join("/")
    pick.mutate(
      { defaultPath },
      {
        onSuccess: (path) => {
          if (!path) return
          write.mutate(
            { projectId, relPath, dataset, ops, columns, path },
            { onSuccess: ({ rows }) => setDone({ path, rows }) },
          )
        },
      },
    )
  }
  const error = pick.error ?? write.error
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        data-testid="analysis-table-export"
        disabled={!projectPath || pick.isPending || write.isPending}
        data-feature-label={t("Export CSV")}
        data-feature-help={t(
          "Save the table as it is shown (filters, aggregation, sort, shown columns) as a new CSV file. The source file is not changed",
        )}
        aria-label={t("Export CSV")}
        title={t("Export CSV")}
        onClick={start}
        className="flex size-6 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-50"
      >
        <Download className="size-3.5" aria-hidden />
      </button>
      {done ? (
        <span data-testid="analysis-table-exported" className="text-muted-foreground text-xs">
          {t("Saved {count} rows to {name}")
            .replace("{count}", done.rows.toLocaleString())
            .replace("{name}", done.path.slice(done.path.lastIndexOf("/") + 1))}
        </span>
      ) : null}
      {error ? <span className="text-destructive text-xs">{error.message}</span> : null}
    </div>
  )
}
