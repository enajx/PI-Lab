import { useQueries } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, Maximize2, Minimize2, ZoomIn, ZoomOut } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { TableOps, TablePage } from "../../../../../../../../main/trpc/science/analysis"
import { useTranslate } from "../../../../../../../i18n/language"
import { useTRPC } from "../../../../../../../trpc/react"
import { formatNumber, type NumberFormat } from "./formatNumber"

/**
 * The rows of a table after its operations, scrolled through all of them:
 * only the rows in view are drawn, and they are fetched 200 at a time
 * (`science.analysis.table`). A header click sorts by that column (ascending,
 * descending, off). Text size + / − and Fit (shrink to the panel width) are
 * kept per user in `localStorage`.
 */

/** Rows fetched per request. */
const PAGE_ROWS = 200
/** Rows drawn above and below the visible ones. */
const OVERSCAN = 20
/** Row height and text size at zoom 1. */
const ROW_HEIGHT = 26
const FONT_SIZE = 12
const MIN_ZOOM = 0.4
const MAX_ZOOM = 2
const ZOOM_STEP = 0.1
const ZOOM_KEY = "pi-lab.analysis.tableZoom"

function readZoom(): number {
  const value = Number(window.localStorage.getItem(ZOOM_KEY) ?? "1")
  return Number.isFinite(value) && value >= MIN_ZOOM && value <= MAX_ZOOM ? value : 1
}

function storeZoom(zoom: number): void {
  window.localStorage.setItem(ZOOM_KEY, String(zoom))
}

function clampZoom(zoom: number): number {
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) * 100) / 100
}

export function DataTable({
  projectId,
  relPath,
  dataset,
  ops,
  firstPage,
  updating,
  shown,
  format,
  onSort,
}: {
  projectId: string
  relPath: string
  dataset: string | null
  ops: TableOps
  /** The first rows, which also give the columns and the row count. */
  firstPage: TablePage
  /** True while `firstPage` is the previous result and the new one loads: it is dimmed and no more rows load. */
  updating: boolean
  /** Indexes into the page's columns to show, in order. */
  shown: number[]
  format: NumberFormat
  /** Sort by one column (or none), from a header click. */
  onSort: (sort: TableOps["sort"]) => void
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const scroller = useRef<HTMLDivElement>(null)
  const [zoom, setZoomState] = useState(readZoom)
  /** The zoom Fit last set, so a second click can go back to 100%. */
  const fitZoom = useRef<number | null>(null)
  const [view, setView] = useState({ top: 0, height: 480 })
  const setZoom = (next: number): void => {
    const value = clampZoom(next)
    setZoomState(value)
    storeZoom(value)
  }

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const measure = () => setView({ top: element.scrollTop, height: element.clientHeight })
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const rowHeight = Math.round(ROW_HEIGHT * zoom)
  // Padding scales with the text, so Fit shrinks the whole table in one step.
  const cellPadding = 8 * zoom
  const total = firstPage.totalRows
  const first = Math.max(0, Math.floor(view.top / rowHeight) - OVERSCAN)
  const last = Math.min(total, Math.ceil((view.top + view.height) / rowHeight) + OVERSCAN)
  const pageNumbers: number[] = []
  for (let page = Math.floor(first / PAGE_ROWS); page * PAGE_ROWS < last; page++) {
    pageNumbers.push(page)
  }
  const pages = useQueries({
    queries: pageNumbers.map((page) => ({
      ...trpc.science.analysis.table.queryOptions({
        projectId,
        relPath,
        dataset,
        ops,
        offset: page * PAGE_ROWS,
        limit: PAGE_ROWS,
      }),
      staleTime: 30_000,
      enabled: !updating,
    })),
  })
  const rowAt = (index: number): string[] | null => {
    if (index < firstPage.rows.length) return firstPage.rows[index] ?? null
    const page = pages[pageNumbers.indexOf(Math.floor(index / PAGE_ROWS))]
    return page?.data?.rows[index % PAGE_ROWS] ?? null
  }
  const pageError = pages.find((page) => page.isError)?.error

  const numeric = firstPage.columns.map((column) => column.kind === "number")
  const sortOf = (name: string) => ops.sort.find((key) => key.column === name)
  const clickHeader = (name: string): void => {
    const key = sortOf(name)
    if (!key) onSort([{ column: name, descending: false }])
    else if (!key.descending) onSort([{ column: name, descending: true }])
    else onSort([])
  }
  // Fit, then a second click goes back to 100%.
  const fitted = fitZoom.current !== null && Math.abs(zoom - fitZoom.current) < 0.005
  const fit = (): void => {
    if (fitted) {
      fitZoom.current = null
      setZoom(1)
      return
    }
    const element = scroller.current
    const table = element?.querySelector("table")
    if (!element || !table || table.scrollWidth === 0) return
    const next = clampZoom((zoom * element.clientWidth) / table.scrollWidth)
    fitZoom.current = next
    setZoom(next)
  }

  const rows: number[] = []
  for (let index = first; index < last; index++) rows.push(index)

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex min-h-0 gap-1.5">
        <div
          ref={scroller}
          data-testid="analysis-table-scroll"
          onScroll={(event) =>
            setView({
              top: event.currentTarget.scrollTop,
              height: event.currentTarget.clientHeight,
            })
          }
          aria-busy={updating}
          className={`max-h-[70vh] min-h-24 min-w-0 flex-1 overflow-auto rounded-md border border-border ${
            updating ? "opacity-50" : ""
          }`}
        >
          <table
            data-testid="analysis-preview-table"
            className="border-collapse"
            style={{ fontSize: FONT_SIZE * zoom }}
          >
            <thead className="sticky top-0 z-10 bg-muted">
              <tr className="border-border border-b">
                {shown.map((col) => {
                  const name = firstPage.headers[col] ?? ""
                  const key = sortOf(name)
                  return (
                    <th
                      key={name}
                      className="whitespace-nowrap text-left font-medium"
                      style={{ height: rowHeight, paddingInline: cellPadding }}
                    >
                      <button
                        type="button"
                        data-testid="analysis-table-header"
                        title={t("Sort by this column")}
                        onClick={() => clickHeader(name)}
                        className="flex items-center gap-1 hover:text-foreground"
                      >
                        {name}
                        {key ? (
                          key.descending ? (
                            <ArrowDown className="size-3" aria-label={t("descending")} />
                          ) : (
                            <ArrowUp className="size-3" aria-label={t("ascending")} />
                          )
                        ) : null}
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {first > 0 ? (
                <tr aria-hidden style={{ height: first * rowHeight }}>
                  <td colSpan={shown.length} />
                </tr>
              ) : null}
              {rows.map((index) => {
                const row = rowAt(index)
                return (
                  <tr
                    key={index}
                    data-testid="analysis-table-row"
                    data-row={index}
                    className="border-border border-b last:border-b-0"
                    style={{ height: rowHeight }}
                  >
                    {shown.map((col) => {
                      const cell = row?.[col] ?? ""
                      const text = numeric[col] ? formatNumber(cell, format) : cell
                      return (
                        <td
                          key={col}
                          title={cell.length > 60 ? cell : undefined}
                          style={{ paddingInline: cellPadding }}
                          className={`max-w-[28em] select-text cursor-text truncate whitespace-nowrap font-mono ${
                            numeric[col] ? "text-right" : ""
                          } ${row ? "" : "text-muted-foreground"}`}
                        >
                          {row ? text : "…"}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
              {last < total ? (
                <tr aria-hidden style={{ height: (total - last) * rowHeight }}>
                  <td colSpan={shown.length} />
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="flex shrink-0 flex-col items-center gap-1">
          <ZoomButton
            testId="analysis-table-zoom-in"
            label={t("Larger text")}
            help={t("Make the table text larger")}
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoom(zoom + ZOOM_STEP)}
          >
            <ZoomIn className="size-3.5" aria-hidden />
          </ZoomButton>
          <ZoomButton
            testId="analysis-table-zoom-out"
            label={t("Smaller text")}
            help={t("Make the table text smaller, so more columns fit")}
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoom(zoom - ZOOM_STEP)}
          >
            <ZoomOut className="size-3.5" aria-hidden />
          </ZoomButton>
          <ZoomButton
            testId="analysis-table-zoom-fit"
            label={fitted ? t("Back to 100%") : t("Fit to width")}
            help={t(
              "Shrink the table so all its columns fit the panel width; click again to go back to 100%",
            )}
            disabled={false}
            onClick={fit}
          >
            {fitted ? (
              <Minimize2 className="size-3.5" aria-hidden />
            ) : (
              <Maximize2 className="size-3.5" aria-hidden />
            )}
          </ZoomButton>
          <span
            data-testid="analysis-table-zoom"
            className="text-center text-[10px] text-muted-foreground"
          >
            {`${Math.round(zoom * 100)}%`}
          </span>
        </div>
      </div>
      {pageError ? (
        <p className="select-text cursor-text text-destructive text-xs">{pageError.message}</p>
      ) : null}
      <p data-testid="analysis-preview-rowcount" className="text-muted-foreground text-xs">
        {updating
          ? t("Updating…")
          : firstPage.partial
            ? t("{count} rows from the first part of the file").replace(
                "{count}",
                total.toLocaleString(),
              )
            : `${total.toLocaleString()} ${total === 1 ? t("row") : t("rows")}`}
      </p>
    </div>
  )
}

function ZoomButton({
  testId,
  label,
  help,
  disabled,
  onClick,
  children,
}: {
  testId: string
  label: string
  help: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      data-feature-label={label}
      data-feature-help={help}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  )
}
