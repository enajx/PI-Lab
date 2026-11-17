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
 * The chart's fields in the Settings popover (Chart view): chart type, split
 * by a column, how rows with the same x combine, and the spread band. Columns
 * are those of the table after its operations. X and Y are in the toolbar
 * ({@link AxisPickers}).
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

export function ChartFields({
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
  const splittable = columns.filter(
    (c) => (c.role === "factor" || c.role === "text") && c.name !== spec.x,
  )
  const bandAllowed = spec.aggregate === "mean" || spec.aggregate === "median"
  return (
    <>
      <Field label={t("Chart type")}>
        <select
          data-testid="analysis-chart-type"
          value={spec.chartType}
          onChange={(event) => onChange({ ...spec, chartType: event.target.value as ChartType })}
          className={`w-full ${CONTROL_CLASS}`}
        >
          {CHART_TYPES.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.label)}
            </option>
          ))}
        </select>
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
        onClick={onReset}
        className="self-start rounded-md border border-border px-2 py-0.5 hover:bg-accent/60"
      >
        {t("Reset chart to default")}
      </button>
    </>
  )
}

/**
 * The chart's x column (a select) and y columns (a button that opens a list of
 * checkboxes), shown in the toolbar in Chart view.
 */
export function AxisPickers({
  spec,
  columns,
  onChange,
}: {
  spec: ChartSpec
  columns: ColumnInfo[]
  onChange: (spec: ChartSpec) => void
}) {
  const t = useTranslate()
  const columnLabel = useColumnLabel()
  const plottable = columns.filter((c) => c.kind !== "text" && c.name !== spec.x)
  const xColumn = columns.find((c) => c.name === spec.x)
  const pickX = (x: string): void => {
    const y = spec.y.filter((name) => name !== x)
    const fallback = columns.find((c) => c.kind !== "text" && c.name !== x)
    onChange({
      ...spec,
      x,
      y: y.length > 0 ? y : fallback ? [fallback.name] : spec.y,
      splitBy: spec.splitBy === x ? null : spec.splitBy,
    })
  }
  return (
    <div className="flex min-w-0 items-center gap-3 text-xs">
      <div className="flex min-w-0 items-center gap-1">
        <span className="text-muted-foreground">{t("Y:")}</span>
        <SettingsPopover
          icon={null}
          label={spec.y.join(", ")}
          help={t("Choose the columns plotted on the y axis")}
          testId="analysis-chart-y-button"
          iconOnly={false}
          chevron={true}
          active={false}
        >
          {() => (
            <div data-testid="analysis-chart-y" className="flex flex-col gap-1">
              {plottable.map((c) => {
                const checked = spec.y.includes(c.name)
                return (
                  <label
                    key={c.name}
                    className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/60"
                  >
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
          )}
        </SettingsPopover>
      </div>
      <div className="flex min-w-0 items-center gap-1">
        <span className="text-muted-foreground">{t("X:")}</span>
        <SettingsPopover
          icon={null}
          label={xColumn ? columnLabel(xColumn) : spec.x}
          help={t("Choose the column on the x axis")}
          testId="analysis-chart-x"
          iconOnly={false}
          chevron={true}
          active={false}
        >
          {(close) => (
            <div data-testid="analysis-chart-x-list" className="flex flex-col">
              {columns.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  role="option"
                  aria-selected={c.name === spec.x}
                  data-testid="analysis-chart-x-option"
                  onClick={() => {
                    close()
                    if (c.name !== spec.x) pickX(c.name)
                  }}
                  className={`truncate rounded px-1 py-0.5 text-left hover:bg-accent/60 ${
                    c.name === spec.x ? "font-medium text-foreground" : ""
                  }`}
                >
                  {columnLabel(c)}
                </button>
              ))}
            </div>
          )}
        </SettingsPopover>
      </div>
    </div>
  )
}
