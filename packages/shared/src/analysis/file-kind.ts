/**
 * Data/analysis file classifier for the Science → Analysis tab. A **pure, total, deterministic** function from a file
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
  | "animation"
  | "video"
  | "notebook"
  | "marimo"
  | "parquet"
  | "dataset"
  | "npy"
  | "npz"
  | "pdf"
  | "plot"
  | "report"
  | "markdown"
  | "markup"
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
  webp: "image",
  bmp: "image",
  svg: "image",
  tif: "image",
  tiff: "image",
  // Animations: gifs and videos, streamed to the preview from the file
  gif: "animation",
  mp4: "video",
  m4v: "video",
  webm: "video",
  mov: "video",
  mkv: "video",
  avi: "video",
  ogv: "video",
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
  // PDF figures (previewed with the bundled PDF.js viewer)
  pdf: "pdf",
  // Static plot/figure outputs with no inline preview
  eps: "plot",
  ps: "plot",
  // Rendered reports
  html: "report",
  htm: "report",
  // Prose / docs
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  // Quarto Markdown (shown as Markdown until it can be rendered)
  qmd: "markdown",
  // Plain text & logs (head-previewable)
  txt: "text",
  text: "text",
  log: "text",
  dat: "text",
  out: "text",
  // Config and markup files (head-previewable)
  yaml: "markup",
  yml: "markup",
  toml: "markup",
  xml: "markup",
  ini: "markup",
  cfg: "markup",
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
  "animation",
  "video",
  "notebook",
  "marimo",
  "parquet",
  "dataset",
  "npy",
  "npz",
  "pdf",
  "plot",
  "report",
  "markdown",
  "markup",
  "text",
  "other",
] as const

/** The label of each kind, shown as the file's kind in the preview. */
export const DATA_FILE_KIND_LABELS: Readonly<Record<DataFileKind, string>> = {
  csv: "CSV",
  tsv: "TSV",
  json: "JSON",
  image: "Figure",
  animation: "Animation",
  video: "Video",
  notebook: "Notebooks",
  marimo: "marimo",
  parquet: "Parquet",
  dataset: "Datasets",
  npy: "NumPy",
  npz: "NumPy (zip)",
  pdf: "Figure",
  plot: "Figure",
  report: "Reports",
  markdown: "Markdown",
  markup: "Markup",
  text: "Text",
  other: "Other",
}

/**
 * The categories of the Analysis filter chips: Data (tables, arrays, stores),
 * Figures (images, PDFs, plots), Animations (gifs, videos), Markup (JSON, YAML, TOML, XML…), Text (text,
 * logs, Markdown), Notebooks, Reports (HTML) and Other. A chip with several
 * formats present ({@link fileFormatOf}) shows them as a second row of chips.
 */
export type DataFileCategory =
  | "data"
  | "figure"
  | "animation"
  | "markup"
  | "text"
  | "notebook"
  | "report"
  | "other"

/** Kind → category lookup; the authoritative map {@link categoryOf} reads. */
const CATEGORY_BY_KIND: Readonly<Record<DataFileKind, DataFileCategory>> = {
  csv: "data",
  tsv: "data",
  parquet: "data",
  dataset: "data",
  npy: "data",
  npz: "data",
  image: "figure",
  pdf: "figure",
  plot: "figure",
  animation: "animation",
  video: "animation",
  json: "markup",
  markup: "markup",
  text: "text",
  markdown: "text",
  notebook: "notebook",
  marimo: "notebook",
  report: "report",
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
  "figure",
  "animation",
  "markup",
  "text",
  "notebook",
  "report",
  "other",
] as const

/** Human-readable labels for each category (the filter chips). */
export const DATA_FILE_CATEGORY_LABELS: Readonly<Record<DataFileCategory, string>> = {
  data: "Data",
  figure: "Figures",
  animation: "Animations",
  markup: "Markup",
  text: "Text",
  notebook: "Notebooks",
  report: "Reports",
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

/** One chip of the format row: a label and the extensions it matches. */
export interface FormatChip {
  /** Unique id (the first extension), used in test ids and as the filter value. */
  id: string
  label: string
  extensions: readonly string[]
}

/** A chip for one or more extensions; the id is the first extension. */
function chip(label: string, extensions: readonly string[]): FormatChip {
  return { id: extensions[0] ?? label.toLowerCase(), label, extensions }
}

/**
 * The fixed, ordered format chips of each category: at most six of the most
 * common ones, so the row fits one line at the default panel width. A selected
 * category's row lists all of them (absent ones greyed out), then any other
 * format present in the folder ({@link formatChipOf}).
 */
const FORMAT_CHIPS: Readonly<Record<DataFileCategory, readonly FormatChip[]>> = {
  data: [
    chip("CSV", ["csv"]),
    chip("PARQUET", ["parquet", "pq"]),
    chip("NPY", ["npy"]),
    chip("NPZ", ["npz"]),
    chip("H5", ["h5", "hdf5"]),
    chip("DB", ["db", "sqlite", "sqlite3"]),
  ],
  figure: [
    chip("PNG", ["png"]),
    chip("PDF", ["pdf"]),
    chip("SVG", ["svg"]),
    chip("JPG", ["jpg", "jpeg"]),
  ],
  animation: [
    chip("MP4", ["mp4"]),
    chip("GIF", ["gif"]),
    chip("WEBM", ["webm"]),
    chip("MOV", ["mov"]),
    chip("MKV", ["mkv"]),
  ],
  markup: [
    chip("YAML", ["yaml", "yml"]),
    chip("TOML", ["toml"]),
    chip("JSON", ["json"]),
    chip("XML", ["xml"]),
  ],
  text: [chip("TXT", ["txt"]), chip("MD", ["md"]), chip("LOG", ["log"])],
  notebook: [chip("IPYNB", ["ipynb"]), chip("PY", ["py"])],
  report: [chip("HTML", ["html", "htm"])],
  other: [],
}

/** The fixed, ordered format chips of a category. */
export function formatChipsOf(category: DataFileCategory): readonly FormatChip[] {
  return FORMAT_CHIPS[category]
}

/**
 * The chip an extension (from {@link fileFormatOf}) belongs to: its chip in
 * the fixed lists (so `yml` is the YAML chip), else a chip of its own.
 */
export function formatChipOf(extension: string): FormatChip {
  for (const category of ALL_DATA_FILE_CATEGORIES) {
    const found = FORMAT_CHIPS[category].find((candidate) =>
      candidate.extensions.includes(extension),
    )
    if (found) return found
  }
  return chip(extension.toUpperCase(), [extension])
}

/**
 * The file's format: its lowercase extension (`pdf`, `png`, `zarr`), or `""`
 * with none. A filter chip's sub-list offers one entry per format present.
 */
export function fileFormatOf(filePath: string): string {
  return extensionOf(filePath)
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
 * (table / chart / array / image / pretty-JSON / text head / notebook cells /
 * isolated web surface / PDF viewer). Raw `.npy` arrays decode into a chart or
 * grid; Jupyter notebooks show their cells; HTML reports and marimo notebooks
 * open in their isolated interactive surface; PDFs open in the bundled PDF.js
 * viewer. `.npz` (a zip of arrays we don't unpack),
 * `parquet`, `dataset`, `plot`, and `other` fall back to a metadata-only card.
 */
export function isPreviewableKind(kind: DataFileKind): boolean {
  return (
    kind === "csv" ||
    kind === "tsv" ||
    kind === "json" ||
    kind === "image" ||
    kind === "marimo" ||
    kind === "notebook" ||
    kind === "report" ||
    kind === "markdown" ||
    kind === "markup" ||
    kind === "text" ||
    kind === "npy" ||
    kind === "pdf" ||
    kind === "animation" ||
    kind === "video"
  )
}
