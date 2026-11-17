import { Sigma, X } from "lucide-react"
import type {
  AggFunction,
  Aggregation,
  ColumnInfo,
} from "../../../../../../../../main/trpc/science/analysis"
import { useTranslate } from "../../../../../../../i18n/language"
import { useColumnLabel } from "./ChartSettings"
import { CONTROL_CLASS, Field, SettingsPopover } from "./SettingsPopover"

/**
 * The "Aggregate" popover: one optional aggregation of the filtered rows
 * (group by + aggregate, pivot table, describe, value counts). Its result
 * replaces the table and is what the chart builder plots.
 */

const FUNCTIONS: AggFunction[] = [
  "mean",
  "median",
  "sum",
  "count",
  "nunique",
  "min",
  "max",
  "std",
  "sem",
  "first",
  "last",
]

type Kind = Aggregation["kind"] | "none"

const KINDS: Array<{ value: Kind; label: string }> = [
  { value: "none", label: "None" },
  { value: "groupBy", label: "Group by" },
  { value: "pivot", label: "Pivot table" },
  { value: "describe", label: "Describe" },
  { value: "valueCounts", label: "Value counts" },
]

/** A first guess for a new aggregation of `kind`, from the column roles. */
function startOf(kind: Kind, columns: ColumnInfo[]): Aggregation | null {
  // Numeric factors (e.g. `question`) first, as the default chart does; text with one value groups nothing.
  const factors = [
    ...columns.filter((c) => (c.role === "factor" || c.role === "step") && c.kind === "number"),
    ...columns.filter((c) => (c.role === "factor" || c.role === "step") && c.kind !== "number"),
  ]
  const measure =
    columns.find((c) => c.role === "measure") ?? columns.find((c) => c.kind !== "text")
  const first = factors[0] ?? columns[0]
  const second = factors[1] ?? columns[1] ?? first
  if (kind === "none" || !first) return null
  if (kind === "describe") return { kind }
  if (kind === "valueCounts") return { kind, columns: [first.name] }
  if (kind === "groupBy") {
    return {
      kind,
      by: [first.name],
      values: measure ? [{ column: measure.name, fn: "mean" }] : [],
    }
  }
  return {
    kind,
    index: first.name,
    columns: second?.name ?? first.name,
    values: (measure ?? first).name,
    fn: "mean",
  }
}

export function AggregateSettings({
  columns,
  aggregation,
  onChange,
}: {
  /** The file's columns. */
  columns: ColumnInfo[]
  aggregation: Aggregation | null
  onChange: (aggregation: Aggregation | null) => void
}) {
  const t = useTranslate()
  const columnLabel = useColumnLabel()
  const names = columns.map((c) => c.name)
  const columnSelect = (value: string, onPick: (name: string) => void, testId: string) => (
    <select
      data-testid={testId}
      value={value}
      onChange={(event) => onPick(event.target.value)}
      className={`w-full ${CONTROL_CLASS}`}
    >
      {columns.map((c) => (
        <option key={c.name} value={c.name}>
          {columnLabel(c)}
        </option>
      ))}
    </select>
  )
  const fnSelect = (value: AggFunction, onPick: (fn: AggFunction) => void, testId: string) => (
    <select
      data-testid={testId}
      value={value}
      onChange={(event) => onPick(event.target.value as AggFunction)}
      className={CONTROL_CLASS}
    >
      {FUNCTIONS.map((fn) => (
        <option key={fn} value={fn}>
          {fn}
        </option>
      ))}
    </select>
  )
  const columnChecks = (picked: string[], onPick: (names: string[]) => void, testId: string) => (
    <div
      data-testid={testId}
      className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-md border border-border p-1.5"
    >
      {columns.map((c) => {
        const checked = picked.includes(c.name)
        return (
          <label key={c.name} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={checked}
              disabled={checked && picked.length === 1}
              onChange={() =>
                onPick(
                  checked
                    ? picked.filter((name) => name !== c.name)
                    : names.filter((name) => name === c.name || picked.includes(name)),
                )
              }
            />
            <span className="truncate">{columnLabel(c)}</span>
          </label>
        )
      })}
    </div>
  )

  return (
    <SettingsPopover
      icon={<Sigma className="size-3.5" aria-hidden />}
      label={t("Aggregate")}
      help={t(
        "Group rows and combine their values, make a pivot table, describe every column, or count values. The result replaces the table and is what the chart plots",
      )}
      testId="analysis-table-aggregate"
      iconOnly={true}
      active={aggregation !== null}
    >
      {() => (
        <>
          <Field label={t("Operation")}>
            <select
              data-testid="analysis-aggregate-kind"
              value={aggregation?.kind ?? "none"}
              onChange={(event) => onChange(startOf(event.target.value as Kind, columns))}
              className={`w-full ${CONTROL_CLASS}`}
            >
              {KINDS.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {t(kind.label)}
                </option>
              ))}
            </select>
          </Field>
          {aggregation?.kind === "groupBy" ? (
            <>
              <Field label={t("Group by")}>
                {columnChecks(
                  aggregation.by,
                  (by) => onChange({ ...aggregation, by }),
                  "analysis-aggregate-by",
                )}
              </Field>
              <Field label={t("Values")}>
                <div className="flex flex-col gap-1.5">
                  {aggregation.values.map((value, index) => (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: values are positional
                      key={index}
                      data-testid="analysis-aggregate-value"
                      className="flex items-center gap-1"
                    >
                      <div className="min-w-0 flex-1">
                        {columnSelect(
                          value.column,
                          (column) =>
                            onChange({
                              ...aggregation,
                              values: aggregation.values.map((v, i) =>
                                i === index ? { ...v, column } : v,
                              ),
                            }),
                          "analysis-aggregate-value-column",
                        )}
                      </div>
                      {fnSelect(
                        value.fn,
                        (fn) =>
                          onChange({
                            ...aggregation,
                            values: aggregation.values.map((v, i) =>
                              i === index ? { ...v, fn } : v,
                            ),
                          }),
                        "analysis-aggregate-value-fn",
                      )}
                      <button
                        type="button"
                        aria-label={t("Remove")}
                        onClick={() =>
                          onChange({
                            ...aggregation,
                            values: aggregation.values.filter((_, i) => i !== index),
                          })
                        }
                        className="rounded p-0.5 text-muted-foreground hover:bg-accent/60"
                      >
                        <X className="size-3.5" aria-hidden />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    data-testid="analysis-aggregate-add-value"
                    onClick={() =>
                      onChange({
                        ...aggregation,
                        values: [
                          ...aggregation.values,
                          {
                            column: aggregation.values.at(-1)?.column ?? names[0] ?? "",
                            fn: "count",
                          },
                        ],
                      })
                    }
                    className="self-start rounded-md border border-border px-2 py-0.5 hover:bg-accent/60"
                  >
                    {t("Add value")}
                  </button>
                </div>
              </Field>
            </>
          ) : null}
          {aggregation?.kind === "pivot" ? (
            <>
              <Field label={t("Rows")}>
                {columnSelect(
                  aggregation.index,
                  (index) => onChange({ ...aggregation, index }),
                  "analysis-pivot-index",
                )}
              </Field>
              <Field label={t("Columns")}>
                {columnSelect(
                  aggregation.columns,
                  (across) => onChange({ ...aggregation, columns: across }),
                  "analysis-pivot-columns",
                )}
              </Field>
              <Field label={t("Values")}>
                <div className="flex items-center gap-1">
                  <div className="min-w-0 flex-1">
                    {columnSelect(
                      aggregation.values,
                      (values) => onChange({ ...aggregation, values }),
                      "analysis-pivot-values",
                    )}
                  </div>
                  {fnSelect(
                    aggregation.fn,
                    (fn) => onChange({ ...aggregation, fn }),
                    "analysis-pivot-fn",
                  )}
                </div>
              </Field>
            </>
          ) : null}
          {aggregation?.kind === "valueCounts" ? (
            <Field label={t("Count the values of")}>
              {columnChecks(
                aggregation.columns,
                (picked) => onChange({ ...aggregation, columns: picked }),
                "analysis-value-counts-columns",
              )}
            </Field>
          ) : null}
          {aggregation?.kind === "describe" ? (
            <p className="text-muted-foreground">
              {t(
                "Count, mean, std, min, quartiles and max of numeric columns; count, distinct values and the most common value of the others.",
              )}
            </p>
          ) : null}
        </>
      )}
    </SettingsPopover>
  )
}
