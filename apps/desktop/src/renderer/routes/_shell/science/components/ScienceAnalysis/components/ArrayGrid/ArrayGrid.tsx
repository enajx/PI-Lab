import type { ArrayPreview } from "../../../../../../../../main/trpc/science/analysis"
import { useTranslate } from "../../../../../../../i18n/language"

/**
 * Grid renderer for an {@link ArrayPreview} — a decoded 2-D `.npy` array. Shows
 * the dtype + shape as a header chip and the (already bounded, main-side) cells
 * in a monospaced table with a row-index gutter. Empty bodies and the
 * truncation note use selectable text because the body is
 * `user-select: none`).
 */
export function ArrayGrid({ preview }: { preview: ArrayPreview }) {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="rounded-sm bg-muted/60 px-1.5 py-0.5 font-mono text-muted-foreground">
          {preview.dtype}
        </span>
        <span className="text-muted-foreground">
          {t("shape")} [{preview.shape.join(" × ")}]
        </span>
      </div>
      {preview.rows.length === 0 ? (
        <p
          data-testid="analysis-preview-array-empty"
          className="select-text cursor-text text-muted-foreground text-sm"
        >
          {t("The array has no values to show.")}
        </p>
      ) : (
        <div className="overflow-auto rounded-md border border-border">
          <table data-testid="analysis-preview-array" className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-border border-b bg-muted/40">
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground/70">#</th>
                {preview.columns.map((column) => (
                  <th key={column} className="px-2 py-1.5 text-right font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, rowIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional rows
                <tr key={rowIndex} className="border-border border-b last:border-b-0">
                  <td className="px-2 py-1 text-right font-mono text-muted-foreground/60">
                    {rowIndex}
                  </td>
                  {row.map((cell, cellIndex) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: positional cells
                      key={cellIndex}
                      className="select-text cursor-text px-2 py-1 text-right font-mono"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {preview.truncated ? (
        <p className="text-amber-500 text-xs">
          {t("Array truncated — showing the first")} {preview.rows.length} {t("rows and")}{" "}
          {preview.columns.length} {t("columns.")}
        </p>
      ) : null}
    </div>
  )
}
