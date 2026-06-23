/**
 * Data/analysis file classifier for the Science → Analysis tab (AGENTS.md §1
 * "Science tabs", P8c). A **pure, total, deterministic** function from a file
 * path to one of a fixed set of {@link DataFileKind} categories — the single
 * source of truth shared by the main-side walker (which tags every file it
 * discovers) and the renderer (which dispatches each preview to the right
 * sub-renderer). Keeping classification here means the two surfaces can never
 * disagree about what a file *is*.
 *
 * The kind is derived from the filename's extension only (case-insensitive); no
 * filesystem access and no content sniff happen here, so the function is safe to
 * call on arbitrary, untrusted, or non-existent paths. Anything unrecognized —
 * including the empty string, a dot-only name, or a path with no extension —
 * resolves to `"other"`, never an exception.
 */

/** The categories a discovered data/analysis file can fall into. */
export type DataFileKind =
  | "csv"
  | "tsv"
  | "json"
  | "image"
  | "notebook"
  | "parquet"
  | "plot"
  | "markdown"
  | "text"
  | "other"

/**
 * Extension → kind lookup (keys are lowercase, no leading dot). The authoritative
 * map; {@link classifyDataFile} does nothing but normalize an extension and read
 * it. Grouped by kind for readability.
 */
const KIND_BY_EXTENSION: Readonly<Record<string, DataFileKind>> = {
  // Tabular
  csv: "csv",
  tsv: "tsv",
  tab: "tsv",
  // Structured data
  json: "json",
  jsonl: "json",
  ndjson: "json",
  geojson: "json",
  // Raster + vector images (previewable inline)
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  svg: "image",
  // Computational notebooks
  ipynb: "notebook",
  // Columnar binary data stores
  parquet: "parquet",
  pq: "parquet",
  feather: "parquet",
  arrow: "parquet",
  // Static plot/figure outputs (rendered, not raw images)
  pdf: "plot",
  eps: "plot",
  ps: "plot",
  // Prose / docs
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  // Plain text & logs (head-previewable)
  txt: "text",
  text: "text",
  log: "text",
  dat: "text",
  out: "text",
  yaml: "text",
  yml: "text",
  toml: "text",
  ini: "text",
  cfg: "text",
}

/**
 * Ordered list of every kind — the canonical order for filter chips / grouping
 * headers in the Analysis UI (most analysis-relevant first, `other` last).
 */
export const ALL_DATA_FILE_KINDS: readonly DataFileKind[] = [
  "csv",
  "tsv",
  "json",
  "image",
  "notebook",
  "parquet",
  "plot",
  "markdown",
  "text",
  "other",
] as const

/** Human-readable labels for each kind (filter chips / group headers). */
export const DATA_FILE_KIND_LABELS: Readonly<Record<DataFileKind, string>> = {
  csv: "CSV",
  tsv: "TSV",
  json: "JSON",
  image: "Images",
  notebook: "Notebooks",
  parquet: "Parquet",
  plot: "Plots",
  markdown: "Markdown",
  text: "Text",
  other: "Other",
}

/**
 * Extract the lowercase extension of a path (the segment after the final dot of
 * the final path component), or `""` when there is none. Handles both POSIX and
 * Windows separators and treats a leading-dot name (`.gitignore`) as having no
 * extension, matching how a tool would name a dotfile.
 */
function extensionOf(filePath: string): string {
  const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
  const base = lastSep === -1 ? filePath : filePath.slice(lastSep + 1)
  const lastDot = base.lastIndexOf(".")
  // No dot, or a leading dot with nothing after it (`.env`, `..`), or a trailing
  // dot (`foo.`) → no extension.
  if (lastDot <= 0 || lastDot === base.length - 1) return ""
  return base.slice(lastDot + 1).toLowerCase()
}

/**
 * Classify a file path into its {@link DataFileKind}. Total and deterministic:
 * any string yields exactly one kind, with `"other"` as the catch-all. The match
 * is on the file extension only, case-insensitively.
 */
export function classifyDataFile(filePath: string): DataFileKind {
  return KIND_BY_EXTENSION[extensionOf(filePath)] ?? "other"
}

/**
 * Whether a kind is one Analysis can render a meaningful inline preview for
 * (table / image / pretty-JSON / text head). `parquet`, `plot`, `notebook`, and
 * `other` fall back to a metadata-only card — the UI uses this to decide.
 */
export function isPreviewableKind(kind: DataFileKind): boolean {
  return (
    kind === "csv" ||
    kind === "tsv" ||
    kind === "json" ||
    kind === "image" ||
    kind === "markdown" ||
    kind === "text"
  )
}
