import { Settings2 } from "lucide-react"
import type {
  ChartAggregate,
  ChartBand,
  ChartSpec,
  ChartType,
  ColumnInfo,
} from "../../../../../../../../main/trpc/science/analysis"
import { useTranslate } from "../../../../../../../i18n/language"
import { CONTROL_CLASS, Field, SettingsPopover } from "./SettingsPopover"

/**
 * The "Chart settings" popover: chart type, x and y columns, split by a
 * column, how rows with the same x combine, and the spread band. Columns are
 * those of the table after its operations.
 */

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

/** A column with its role, e.g. "question (factor)". */
export function useColumnLabel(): (column: ColumnInfo) => string {
  const t = useTranslate()
  return (column) => `${column.name} (${t(column.role)})`
}

export function ChartSettings({
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
  const columnLabel = useColumnLabel()
  const plottable = columns.filter((c) => c.kind !== "text" && c.name !== spec.x)
  const splittable = columns.filter(
    (c) => (c.role === "factor" || c.role === "text") && c.name !== spec.x,
  )
  const bandAllowed = spec.aggregate === "mean" || spec.aggregate === "median"
  return (
    <SettingsPopover
      icon={<Settings2 className="size-3.5" aria-hidden />}
      label={t("Chart settings")}
      help={t(
        "Choose the x and y columns, a column to split lines by, the chart type, how rows with the same x are combined, and the spread band",
      )}
      testId="analysis-chart-settings"
      iconOnly={false}
      active={false}
    >
      {(close) => (
        <>
          <Field label={t("Chart type")}>
            <select
              data-testid="analysis-chart-type"
              value={spec.chartType}
              onChange={(event) =>
                onChange({ ...spec, chartType: event.target.value as ChartType })
              }
              className={`w-full ${CONTROL_CLASS}`}
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
              className={`w-full ${CONTROL_CLASS}`}
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
              className={`w-full ${CONTROL_CLASS}`}
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
              className={`w-full ${CONTROL_CLASS}`}
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
              className={`w-full ${CONTROL_CLASS}`}
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
              close()
              onReset()
            }}
            className="self-start rounded-md border border-border px-2 py-0.5 hover:bg-accent/60"
          >
            {t("Reset to default")}
          </button>
        </>
      )}
    </SettingsPopover>
  )
}
