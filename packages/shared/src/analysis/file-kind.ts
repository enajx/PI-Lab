/**
 * Data/analysis file classifier for the Science → Analysis tab (AGENTS.md "Scope"
 * "Science tabs", P8c). A **pure, total, deterministic** function from a file
 * path to one of a fixed set of {@link DataFileKind} sub-formats — the single
 * source of truth shared by the main-side walker and the renderer. Discovery
 * uses the nullable {@link classifyAnalysisArtifact} boundary so unknown/source
 * files never enter the browser; direct preview dispatch keeps the total
 * {@link classifyDataFile} fallback. A coarser {@link DataFileCategory} layer
 * ({@link categoryOf}) groups related sub-formats (csv/json/npy/… → "data") for
 * the UI's top-level filter chips and group headers.
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
  | "marimo"
  | "parquet"
  | "dataset"
  | "npy"
  | "npz"
  | "plot"
  | "report"
  | "markdown"
  | "text"
  | "other"

/**
 * Extension → kind lookup (keys are lowercase, no leading dot). The authoritative
 * map; {@link classifyDataFile} does nothing but normalize an extension and read
 * it. Only extensions deliberately present here are Analysis artifacts.
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
  tif: "image",
  tiff: "image",
  // Computational notebooks
  ipynb: "notebook",
  // Columnar binary data stores
  parquet: "parquet",
  pq: "parquet",
  feather: "parquet",
  arrow: "parquet",
  // Scientific/container stores (metadata-only preview)
  h5: "dataset",
  hdf5: "dataset",
  he5: "dataset",
  nc: "dataset",
  nc4: "dataset",
  netcdf: "dataset",
  sqlite: "dataset",
  sqlite3: "dataset",
  db: "dataset",
  xls: "dataset",
  xlsx: "dataset",
  xlsm: "dataset",
  ods: "dataset",
  zarr: "dataset",
  // NumPy arrays (raw `.npy` + zipped `.npz`)
  npy: "npy",
  npz: "npz",
  // Static plot/figure outputs (rendered, not raw images)
  pdf: "plot",
  eps: "plot",
  ps: "plot",
  // Rendered reports
  html: "report",
  htm: "report",
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
  // Serialized Python objects are listed for metadata only. Preview code must
  // never deserialize or read their contents.
  pkl: "other",
  pickle: "other",
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
  "marimo",
  "parquet",
  "dataset",
  "npy",
  "npz",
  "plot",
  "report",
  "markdown",
  "text",
  "other",
] as const

/** Sub-format labels for each kind (kept for per-file classification + sub-bubbles). */
export const DATA_FILE_KIND_LABELS: Readonly<Record<DataFileKind, string>> = {
  csv: "CSV",
  tsv: "TSV",
  json: "JSON",
  image: "Images",
  notebook: "Notebooks",
  marimo: "marimo",
  parquet: "Parquet",
  dataset: "Datasets",
  npy: "NumPy",
  npz: "NumPy (zip)",
  plot: "Plots",
  report: "Reports",
  markdown: "Markdown",
  text: "Text",
  other: "Other",
}

/**
 * The coarser categories the Analysis UI groups kinds under. Several tabular /
 * structured / array kinds (csv, tsv, json, parquet, npy, npz) collapse into a
 * single `"data"` category so the top-level filter chips and group headers read
 * "Data" rather than enumerating raw formats; the per-kind {@link DataFileKind}
 * machinery still drives sub-format bubbles and per-file classification.
 */
export type DataFileCategory = "data" | "image" | "notebook" | "plot" | "text" | "other"

/** Kind → category lookup; the authoritative map {@link categoryOf} reads. */
const CATEGORY_BY_KIND: Readonly<Record<DataFileKind, DataFileCategory>> = {
  csv: "data",
  tsv: "data",
  json: "data",
  parquet: "data",
  dataset: "data",
  npy: "data",
  npz: "data",
  image: "image",
  notebook: "notebook",
  marimo: "notebook",
  plot: "plot",
  report: "text",
  markdown: "text",
  text: "text",
  other: "other",
}

/** Map a {@link DataFileKind} to its coarser {@link DataFileCategory}. Total. */
export function categoryOf(kind: DataFileKind): DataFileCategory {
  return CATEGORY_BY_KIND[kind]
}

/**
 * Ordered list of every category — the canonical order for filter chips /
 * grouping headers in the Analysis UI (most analysis-relevant first, `other` last).
 */
export const ALL_DATA_FILE_CATEGORIES: readonly DataFileCategory[] = [
  "data",
  "image",
  "notebook",
  "plot",
  "text",
  "other",
] as const

/** Human-readable labels for each category (filter chips / group headers). */
export const DATA_FILE_CATEGORY_LABELS: Readonly<Record<DataFileCategory, string>> = {
  data: "Data",
  image: "Images",
  notebook: "Notebooks",
  plot: "Plots",
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
 * Classify a path only when it is deliberately allowed into Analysis discovery.
 * Files use the explicit extension whitelist above. Directories are excluded
 * except for `.zarr` stores, which are artifacts in their own right and must not
 * be traversed as ordinary folders.
 */
export function classifyAnalysisArtifact(
  filePath: string,
  entryType: "file" | "directory",
): DataFileKind | null {
  const extension = extensionOf(filePath)
  if (entryType === "directory") return extension === "zarr" ? "dataset" : null
  if (extension === "zarr") return null
  const baseName = filePath.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase()
  if (baseName === "a.out") return null
  return KIND_BY_EXTENSION[extension] ?? null
}

/**
 * Conservatively identify a marimo notebook from a bounded Python source
 * prefix. Merely importing marimo is not enough: the file must also construct
 * an App through the imported module/alias or a direct `App` import. This keeps
 * ordinary Python source out of Analysis discovery.
 */
export function isMarimoNotebookSource(source: string): boolean {
  const moduleImport = source.match(
    /(?:^|\n)\s*import\s+marimo(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/m,
  )
  if (moduleImport) {
    const moduleName = moduleImport[1] ?? "marimo"
    const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (new RegExp(`\\b${escaped}\\.App\\s*\\(`).test(source)) return true
  }

  const directImport = source.match(
    /(?:^|\n)\s*from\s+marimo\s+import\s+(?:[^#\n]*,\s*)?App(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/m,
  )
  if (!directImport) return false
  const appName = directImport[1] ?? "App"
  const escaped = appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`\\b${escaped}\\s*\\(`).test(source)
}

/**
 * Whether a kind is one Analysis can render a meaningful inline preview for
 * (table / chart / array / image / pretty-JSON / text head / isolated web
 * surface). Raw `.npy` arrays decode into a chart or grid; HTML reports and
 * marimo notebooks open in their isolated interactive surface. `.npz` (a zip
 * of arrays we don't unpack), `parquet`, `dataset`, `plot`, `notebook`, and
 * `other` fall back to a metadata-only card.
 */
export function isPreviewableKind(kind: DataFileKind): boolean {
  return (
    kind === "csv" ||
    kind === "tsv" ||
    kind === "json" ||
    kind === "image" ||
    kind === "marimo" ||
    kind === "report" ||
    kind === "markdown" ||
    kind === "text" ||
    kind === "npy"
  )
}
