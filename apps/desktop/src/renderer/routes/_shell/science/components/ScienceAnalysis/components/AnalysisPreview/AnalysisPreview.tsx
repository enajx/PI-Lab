import { DATA_FILE_KIND_LABELS, type DataFileKind } from "@pi-lab/shared/analysis/file-kind"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import type { DataFilePreview } from "../../../../../../../../main/trpc/science/analysis"
import { useInterfaceLanguage, useTranslate } from "../../../../../../../i18n/language"
import { useTRPC } from "../../../../../../../trpc/react"
import { ArrayGrid } from "../ArrayGrid"
import { MetricChart } from "../MetricChart"

/**
 * Preview pane for a single selected data file (P8c). Fetches
 * `science.analysis.preview` and dispatches on the returned payload's `type`:
 * a sampled CSV/TSV table, a line chart (metric logs / 1-D NumPy arrays), a
 * NumPy 2-D array grid, an inline image, pretty-printed JSON, a text head, or a
 * metadata card for kinds with no inline renderer. The pane owns its own
 * vertical scroll; the fetch is keyed on the project + path so switching
 * files re-fetches cleanly.
 */
export function AnalysisPreview({
  projectId,
  relPath,
  kind,
}: {
  projectId: string
  relPath: string
  kind: DataFileKind
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const interactive = kind === "report" || kind === "marimo"
  const preview = useQuery({
    ...trpc.science.analysis.preview.queryOptions({ projectId, relPath }),
    enabled: !interactive,
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
      <div
        data-testid="analysis-preview"
        className={`min-h-0 flex-1 ${interactive ? "overflow-hidden" : "overflow-auto p-4"}`}
      >
        {interactive ? (
          <InteractivePreview
            projectId={projectId}
            relPath={relPath}
            kind={kind === "marimo" ? "marimo" : "report"}
          />
        ) : preview.isLoading ? (
          <p className="text-muted-foreground text-sm">{t("Loading preview…")}</p>
        ) : preview.isError ? (
          <p
            data-testid="analysis-preview-error"
            className="select-text cursor-text text-destructive text-sm"
          >
            {preview.error?.message ?? t("Failed to load preview.")}
          </p>
        ) : preview.data ? (
          <PreviewBody preview={preview.data} />
        ) : null}
      </div>
    </div>
  )
}

type InteractiveStatus = "starting" | "running" | "stopping" | "stopped" | "error"

function InteractivePreview({
  projectId,
  relPath,
  kind,
}: {
  projectId: string
  relPath: string
  kind: "report" | "marimo"
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const ownerId = useRef(`analysis-${crypto.randomUUID()}`)
  const [status, setStatus] = useState<InteractiveStatus>("starting")
  const [url, setUrl] = useState<string | null>(null)
  const [runtime, setRuntime] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const leaseId = useRef<string | null>(null)
  const open = useMutation(trpc.science.analysis.openInteractive.mutationOptions())
  const close = useMutation(trpc.science.analysis.closeInteractive.mutationOptions())

  useEffect(() => {
    let current = true
    const effectLeaseId = crypto.randomUUID()
    leaseId.current = effectLeaseId
    if (attempt > 0) open.reset()
    setStatus("starting")
    setUrl(null)
    setRuntime(null)
    setError(null)
    void open
      .mutateAsync({ ownerId: ownerId.current, leaseId: effectLeaseId, projectId, relPath })
      .then(
        (result) => {
          if (!current) return
          setUrl(result.url)
          setRuntime(result.runtime ?? null)
          setStatus("running")
        },
        (reason: Error) => {
          if (!current) return
          setError(
            reason.message ||
              `${t("Failed to start")} ${kind === "marimo" ? "marimo" : t("report")}`,
          )
          setStatus("error")
        },
      )
    return () => {
      current = false
      void close
        .mutateAsync({ ownerId: ownerId.current, leaseId: effectLeaseId })
        .catch((reason) => console.error("Failed to close interactive Analysis preview", reason))
    }
  }, [attempt, close.mutateAsync, kind, open.mutateAsync, open.reset, projectId, relPath, t])

  const stop = async () => {
    const currentLeaseId = leaseId.current
    if (!currentLeaseId) return
    setStatus("stopping")
    setUrl(null)
    try {
      await close.mutateAsync({ ownerId: ownerId.current, leaseId: currentLeaseId })
      setStatus("stopped")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("Failed to stop marimo"))
      setStatus("error")
    }
  }

  if (status === "starting") {
    return (
      <InteractiveMessage testId="analysis-interactive-starting">
        {kind === "marimo" ? t("Starting marimo…") : t("Opening interactive report…")}
      </InteractiveMessage>
    )
  }
  if (status === "error") {
    return (
      <InteractiveMessage testId="analysis-interactive-error">
        <span className="text-destructive">{error}</span>
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1 text-xs"
          onClick={() => setAttempt((value) => value + 1)}
        >
          {t("Retry")}
        </button>
      </InteractiveMessage>
    )
  }
  if (status === "stopping" || status === "stopped") {
    return (
      <InteractiveMessage testId={`analysis-interactive-${status}`}>
        {status === "stopping" ? t("Stopping marimo…") : t("marimo stopped")}
        {status === "stopped" ? (
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-xs"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {t("Start")}
          </button>
        ) : null}
      </InteractiveMessage>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {kind === "marimo" ? (
        <div className="flex shrink-0 items-center justify-between border-border border-b px-3 py-1.5 text-xs">
          <span data-testid="analysis-marimo-status">
            {t("Running")}
            {runtime ? ` · ${runtime}` : ""}
          </span>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1"
            onClick={() => void stop()}
          >
            {t("Stop")}
          </button>
        </div>
      ) : null}
      {url ? (
        <iframe
          data-testid={kind === "marimo" ? "analysis-preview-marimo" : "analysis-preview-html"}
          title={kind === "marimo" ? t("Live marimo notebook") : t("Interactive HTML report")}
          src={url}
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      ) : null}
    </div>
  )
}

function InteractiveMessage({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <div
      data-testid={testId}
      className="flex h-full items-center justify-center gap-3 p-4 text-muted-foreground text-sm"
    >
      {children}
    </div>
  )
}

/** Dispatch one preview payload to its renderer. */
function PreviewBody({ preview }: { preview: DataFilePreview }) {
  const t = useTranslate()
  switch (preview.type) {
    case "table":
      return <TableBody preview={preview} />
    case "chart":
      return <MetricChart preview={preview} />
    case "array":
      return <ArrayGrid preview={preview} />
    case "image":
      return (
        <img
          data-testid="analysis-preview-image"
          src={preview.dataUrl}
          alt={t("File preview")}
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
  const t = useTranslate()
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
          ? `${t("Showing first")} ${preview.rows.length} ${t("of")} ${preview.totalRows}+ ${t("rows")}`
          : `${preview.totalRows} ${preview.totalRows === 1 ? t("row") : t("rows")}`}
      </p>
    </div>
  )
}

/** Metadata-only fallback for kinds without an inline renderer. */
function MetadataBody({ preview }: { preview: Extract<DataFilePreview, { type: "metadata" }> }) {
  const t = useTranslate()
  const [language] = useInterfaceLanguage()
  return (
    <div
      data-testid="analysis-preview-metadata"
      className="flex flex-col gap-2 rounded-md border border-border bg-card/40 p-4 text-sm"
    >
      <Row label={t("Kind")} value={t(DATA_FILE_KIND_LABELS[preview.kind])} />
      <Row label={t("Size")} value={formatSize(preview.size)} />
      <Row label={t("Modified")} value={new Date(preview.mtime).toLocaleString(language)} />
      {preview.note ? <Row label={t("Note")} value={preview.note} /> : null}
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
  const t = useTranslate()
  return (
    <p className="mt-2 text-amber-500 text-xs">
      {t("Preview truncated — file is larger than shown.")}
    </p>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
