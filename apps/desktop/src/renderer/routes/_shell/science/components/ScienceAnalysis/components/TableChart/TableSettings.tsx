import { ArrowDown, ArrowUp, SlidersHorizontal, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type {
  ColumnInfo,
  RowFilter,
  TableOps,
} from "../../../../../../../../main/trpc/science/analysis"
import { useTranslate } from "../../../../../../../i18n/language"
import type { NumberFormat } from "./formatNumber"
import { CONTROL_CLASS, Field, SettingsPopover } from "./SettingsPopover"

/**
 * The "Table settings" popover: which columns are shown and in what order,
 * the sort, the row filters, and the number format. Filters name the file's
 * columns (they run first); columns and sort name the result's columns.
 */

/** How the table is displayed; it never changes the rows. */
export interface TableDisplay extends NumberFormat {
  hidden: string[]
  order: string[]
}

const FILTER_OPS: Array<{ value: RowFilter["op"]; label: string }> = [
  { value: "eq", label: "=" },
  { value: "ne", label: "≠" },
  { value: "lt", label: "<" },
  { value: "le", label: "≤" },
  { value: "gt", label: ">" },
  { value: "ge", label: "≥" },
  { value: "contains", label: "contains" },
  { value: "in", label: "is one of" },
  { value: "blank", label: "is blank" },
  { value: "notBlank", label: "is not blank" },
]

/** Column names in display order: the saved order first, then the rest as in the table. */
export function orderedColumns(names: string[], order: string[]): string[] {
  const known = order.filter((name) => names.includes(name))
  return [...known, ...names.filter((name) => !known.includes(name))]
}

export function TableSettings({
  sourceColumns,
  resultColumns,
  ops,
  display,
  onOps,
  onDisplay,
}: {
  /** The file's columns (filters run on them). */
  sourceColumns: ColumnInfo[]
  /** The columns after the aggregation (shown, ordered and sorted). */
  resultColumns: ColumnInfo[]
  ops: TableOps
  display: TableDisplay
  onOps: (ops: TableOps) => void
  onDisplay: (display: TableDisplay) => void
}) {
  const t = useTranslate()
  const names = resultColumns.map((c) => c.name)
  const ordered = orderedColumns(names, display.order)
  const active =
    ops.filters.length > 0 ||
    ops.sort.length > 0 ||
    display.hidden.length > 0 ||
    display.decimals !== null ||
    display.scientific
  const move = (name: string, by: number): void => {
    const next = [...ordered]
    const from = next.indexOf(name)
    const to = from + by
    if (to < 0 || to >= next.length) return
    next.splice(from, 1)
    next.splice(to, 0, name)
    onDisplay({ ...display, order: next })
  }

  return (
    <SettingsPopover
      icon={<SlidersHorizontal className="size-3.5" aria-hidden />}
      label={t("Table settings")}
      help={t(
        "Show, hide and reorder columns, sort rows, filter rows, and set how numbers are shown",
      )}
      testId="analysis-table-settings"
      iconOnly={false}
      active={active}
    >
      {() => (
        <>
          <Field label={t("Filter rows (all must match)")}>
            <div data-testid="analysis-table-filters" className="flex flex-col gap-1.5">
              {ops.filters.map((filter, index) => (
                <FilterRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: filters are positional
                  key={index}
                  filter={filter}
                  columns={sourceColumns}
                  onChange={(next) =>
                    onOps({
                      ...ops,
                      filters: ops.filters.map((f, i) => (i === index ? next : f)),
                    })
                  }
                  onRemove={() =>
                    onOps({ ...ops, filters: ops.filters.filter((_, i) => i !== index) })
                  }
                />
              ))}
              <button
                type="button"
                data-testid="analysis-table-add-filter"
                disabled={sourceColumns.length === 0}
                onClick={() =>
                  onOps({
                    ...ops,
                    filters: [
                      ...ops.filters,
                      { column: sourceColumns[0]?.name ?? "", op: "eq", value: "", values: [] },
                    ],
                  })
                }
                className="self-start rounded-md border border-border px-2 py-0.5 hover:bg-accent/60"
              >
                {t("Add filter")}
              </button>
            </div>
          </Field>
          <Field label={t("Sort")}>
            <div data-testid="analysis-table-sort" className="flex flex-col gap-1.5">
              {ops.sort.map((key, index) => (
                <div key={key.column} className="flex items-center gap-1">
                  <select
                    value={key.column}
                    onChange={(event) =>
                      onOps({
                        ...ops,
                        sort: ops.sort.map((k, i) =>
                          i === index ? { ...k, column: event.target.value } : k,
                        ),
                      })
                    }
                    className={`flex-1 ${CONTROL_CLASS}`}
                  >
                    {names.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={key.descending ? "desc" : "asc"}
                    onChange={(event) =>
                      onOps({
                        ...ops,
                        sort: ops.sort.map((k, i) =>
                          i === index ? { ...k, descending: event.target.value === "desc" } : k,
                        ),
                      })
                    }
                    className={CONTROL_CLASS}
                  >
                    <option value="asc">{t("ascending")}</option>
                    <option value="desc">{t("descending")}</option>
                  </select>
                  <RemoveButton
                    onClick={() => onOps({ ...ops, sort: ops.sort.filter((_, i) => i !== index) })}
                  />
                </div>
              ))}
              <button
                type="button"
                data-testid="analysis-table-add-sort"
                disabled={names.every((name) => ops.sort.some((key) => key.column === name))}
                onClick={() => {
                  const next = names.find((name) => !ops.sort.some((key) => key.column === name))
                  if (next)
                    onOps({ ...ops, sort: [...ops.sort, { column: next, descending: false }] })
                }}
                className="self-start rounded-md border border-border px-2 py-0.5 hover:bg-accent/60 disabled:opacity-50"
              >
                {t("Add sort column")}
              </button>
            </div>
          </Field>
          <Field label={t("Columns")}>
            <div
              data-testid="analysis-table-columns"
              className="flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded-md border border-border p-1.5"
            >
              {ordered.map((name, index) => {
                const shown = !display.hidden.includes(name)
                return (
                  <div key={name} className="flex items-center gap-1.5">
                    <label className="flex min-w-0 flex-1 items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={shown}
                        // At least one column stays shown.
                        disabled={shown && display.hidden.length >= names.length - 1}
                        onChange={() =>
                          onDisplay({
                            ...display,
                            hidden: shown
                              ? [...display.hidden, name]
                              : display.hidden.filter((h) => h !== name),
                          })
                        }
                      />
                      <span className="truncate">{name}</span>
                    </label>
                    <button
                      type="button"
                      aria-label={t("Move up")}
                      disabled={index === 0}
                      onClick={() => move(name, -1)}
                      className="rounded p-0.5 hover:bg-accent/60 disabled:opacity-30"
                    >
                      <ArrowUp className="size-3" aria-hidden />
                    </button>
                    <button
                      type="button"
                      aria-label={t("Move down")}
                      disabled={index === ordered.length - 1}
                      onClick={() => move(name, 1)}
                      className="rounded p-0.5 hover:bg-accent/60 disabled:opacity-30"
                    >
                      <ArrowDown className="size-3" aria-hidden />
                    </button>
                  </div>
                )
              })}
            </div>
          </Field>
          <Field label={t("Number format")}>
            <div className="flex items-center gap-2">
              <select
                data-testid="analysis-table-decimals"
                value={display.decimals === null ? "auto" : String(display.decimals)}
                onChange={(event) =>
                  onDisplay({
                    ...display,
                    decimals: event.target.value === "auto" ? null : Number(event.target.value),
                  })
                }
                className={CONTROL_CLASS}
              >
                <option value="auto">{t("Auto (6 significant digits)")}</option>
                {[0, 1, 2, 3, 4, 5, 6, 8].map((n) => (
                  <option key={n} value={n}>
                    {t("{count} decimals").replace("{count}", String(n))}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  data-testid="analysis-table-scientific"
                  checked={display.scientific}
                  onChange={() => onDisplay({ ...display, scientific: !display.scientific })}
                />
                {t("Scientific")}
              </label>
            </div>
          </Field>
        </>
      )}
    </SettingsPopover>
  )
}

/** One filter: column, condition and value. The value applies a moment after typing stops. */
function FilterRow({
  filter,
  columns,
  onChange,
  onRemove,
}: {
  filter: RowFilter
  columns: ColumnInfo[]
  onChange: (filter: RowFilter) => void
  onRemove: () => void
}) {
  const t = useTranslate()
  const typed = filter.op === "in" ? filter.values.join(", ") : filter.value
  const [draft, setDraft] = useState(typed)
  useEffect(() => setDraft(typed), [typed])
  // The latest filter and callback, so a re-render does not restart the wait.
  const latest = useRef({ filter, onChange })
  latest.current = { filter, onChange }
  useEffect(() => {
    if (draft === typed) return
    const timer = setTimeout(() => {
      const { filter: current, onChange: apply } = latest.current
      if (current.op === "in") {
        apply({
          ...current,
          values: draft
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part !== ""),
        })
      } else apply({ ...current, value: draft })
    }, 400)
    return () => clearTimeout(timer)
  }, [draft, typed])
  const needsValue = filter.op !== "blank" && filter.op !== "notBlank"
  return (
    <div
      data-testid="analysis-table-filter"
      className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1"
    >
      <select
        data-testid="analysis-table-filter-column"
        value={filter.column}
        onChange={(event) => onChange({ ...filter, column: event.target.value })}
        className={CONTROL_CLASS}
      >
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
      <select
        data-testid="analysis-table-filter-op"
        value={filter.op}
        onChange={(event) => onChange({ ...filter, op: event.target.value as RowFilter["op"] })}
        className={CONTROL_CLASS}
      >
        {FILTER_OPS.map((option) => (
          <option key={option.value} value={option.value}>
            {t(option.label)}
          </option>
        ))}
      </select>
      <RemoveButton onClick={onRemove} />
      {needsValue ? (
        <input
          data-testid="analysis-table-filter-value"
          value={draft}
          placeholder={filter.op === "in" ? t("a, b, c") : t("value")}
          onChange={(event) => setDraft(event.target.value)}
          className={`col-span-3 ${CONTROL_CLASS}`}
        />
      ) : null}
    </div>
  )
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  const t = useTranslate()
  return (
    <button
      type="button"
      aria-label={t("Remove")}
      title={t("Remove")}
      onClick={onClick}
      className="rounded p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
    >
      <X className="size-3.5" aria-hidden />
    </button>
  )
}
