import { DATA_FILE_KIND_LABELS } from "@skipper/shared"
import { useQuery } from "@tanstack/react-query"
import type { DataFilePreview } from "../../../../../../../../main/trpc/science/analysis"
import { useTRPC } from "../../../../../../../trpc/react"

/**
 * Preview pane for a single selected data file (P8c). Fetches
 * `science.analysis.preview` and dispatches on the returned payload's `type`:
 * a sampled CSV/TSV table, an inline image, pretty-printed JSON, a text head, or
 * a metadata card for kinds with no inline renderer. The pane owns its own
 * vertical scroll (§12.3); the fetch is keyed on the project + path so switching
 * files re-fetches cleanly.
 */
export function AnalysisPreview({ projectId, relPath }: { projectId: string; relPath: string }) {
  const trpc = useTRPC()
  const preview = useQuery({
    ...trpc.science.analysis.preview.queryOptions({ projectId, relPath }),
    staleTime: 30_000,
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-border border-b px-4 py-2">
        <span
          data-testid="analysis-preview-path"
          className="min-w-0 flex-1 truncate font-mono text-foreground text-xs"
          title={relPath}
        >
          {relPath}
        </span>
      </div>
      <div data-testid="analysis-preview" className="min-h-0 flex-1 overflow-auto p-4">
        {preview.isLoading ? (
          <p className="text-muted-foreground text-sm">Loading preview…</p>
        ) : preview.isError ? (
          <p
            data-testid="analysis-preview-error"
            className="select-text cursor-text text-destructive text-sm"
          >
            {preview.error?.message ?? "Failed to load preview."}
          </p>
        ) : preview.data ? (
          <PreviewBody preview={preview.data} />
        ) : null}
      </div>
    </div>
  )
}

/** Dispatch one preview payload to its renderer. */
function PreviewBody({ preview }: { preview: DataFilePreview }) {
  switch (preview.type) {
    case "table":
      return <TableBody preview={preview} />
    case "image":
      return (
        <img
          data-testid="analysis-preview-image"
          src={preview.dataUrl}
          alt="File preview"
          className="max-h-full max-w-full rounded-md border border-border object-contain"
        />
      )
    case "json":
      return (
        <pre
          data-testid="analysis-preview-json"
          className="select-text cursor-text whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs"
        >
          {preview.text}
        </pre>
      )
    case "text":
      return (
        <>
          <pre
            data-testid="analysis-preview-text"
            className="select-text cursor-text whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs"
          >
            {preview.text}
          </pre>
          {preview.truncated ? <TruncatedNote /> : null}
        </>
      )
    default:
      return <MetadataBody preview={preview} />
  }
}

/** A sampled CSV/TSV table. */
function TableBody({ preview }: { preview: Extract<DataFilePreview, { type: "table" }> }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-auto rounded-md border border-border">
        <table data-testid="analysis-preview-table" className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-border border-b bg-muted/40">
              {preview.headers.map((header, i) => (
                // Header cells are positional; a CSV may repeat or omit names.
                // biome-ignore lint/suspicious/noArrayIndexKey: positional columns
                <th key={i} className="px-2 py-1.5 text-left font-medium">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, rowIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional rows
              <tr key={rowIndex} className="border-border border-b last:border-b-0">
                {row.map((cell, cellIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional cells
                  <td key={cellIndex} className="select-text cursor-text px-2 py-1 font-mono">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p data-testid="analysis-preview-rowcount" className="text-muted-foreground text-xs">
        {preview.truncated
          ? `Showing first ${preview.rows.length} of ${preview.totalRows}+ rows`
          : `${preview.totalRows} ${preview.totalRows === 1 ? "row" : "rows"}`}
      </p>
    </div>
  )
}

/** Metadata-only fallback for kinds without an inline renderer. */
function MetadataBody({ preview }: { preview: Extract<DataFilePreview, { type: "metadata" }> }) {
  return (
    <div
      data-testid="analysis-preview-metadata"
      className="flex flex-col gap-2 rounded-md border border-border bg-card/40 p-4 text-sm"
    >
      <Row label="Kind" value={DATA_FILE_KIND_LABELS[preview.kind]} />
      <Row label="Size" value={formatSize(preview.size)} />
      <Row label="Modified" value={new Date(preview.mtime).toLocaleString()} />
      {preview.note ? <Row label="Note" value={preview.note} /> : null}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </span>
      <span className="select-text cursor-text text-foreground text-xs">{value}</span>
    </div>
  )
}

function TruncatedNote() {
  return (
    <p className="mt-2 text-amber-500 text-xs">Preview truncated — file is larger than shown.</p>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
