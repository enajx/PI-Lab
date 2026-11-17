import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from "node:zlib"
import {
  asyncBufferFromFile,
  type Compressors,
  parquetMetadataAsync,
  parquetReadObjects,
  parquetSchema,
} from "hyparquet"
import {
  type DataFilePreview,
  formatCell,
  MAX_FRAME_ROWS,
  MAX_TABLE_ROWS,
  type MetadataPreview,
} from "./previewShapes"
import { type Frame, frameFromValues, tableFromFrame } from "./tables"

/**
 * Parquet previews with hyparquet (pure JavaScript). Only the footer and the
 * pages holding the first {@link MAX_FRAME_ROWS} rows are read; the table
 * shows every top-level column and the file's total row count. SNAPPY is
 * built into hyparquet; GZIP, BROTLI and ZSTD use Node's zlib. Other codecs
 * (LZ4, LZO) end in a note naming the codec.
 */

const COMPRESSORS: Compressors = {
  GZIP: (input) => new Uint8Array(gunzipSync(input)),
  BROTLI: (input) => new Uint8Array(brotliDecompressSync(input)),
  ZSTD: (input) => new Uint8Array(zstdDecompressSync(input)),
}

/** Codecs that are neither built into hyparquet nor in {@link COMPRESSORS}. */
const UNSUPPORTED_CODECS = new Set(["LZ4", "LZ4_RAW", "LZO"])

/**
 * Above this compressed size of the first row group, Analysis asks before
 * reading (hyparquet reads a row group's column chunks whole unless the file
 * has an offset index, and pyarrow writes none by default).
 */
export const MAX_PARQUET_ROW_GROUP_BYTES = 32 * 1024 * 1024

export async function previewParquet(
  abs: string,
  size: number,
  load: boolean,
  meta: (note?: string) => MetadataPreview,
): Promise<DataFilePreview> {
  const read = await readParquetFrame(abs, load, MAX_FRAME_ROWS)
  if (read.kind === "note") return meta(read.note)
  if (read.kind === "large")
    return { type: "large", kind: "parquet", size, huge: false, partial: null }
  return tableFromFrame(read.frame)
}

/**
 * Read the first `maxRows` rows of a Parquet file into a frame. A
 * file hyparquet cannot read, or an unsupported codec, is a note; a first row
 * group over {@link MAX_PARQUET_ROW_GROUP_BYTES} is "large" unless `load`.
 */
export async function readParquetFrame(
  abs: string,
  load: boolean,
  maxRows: number,
): Promise<{ kind: "frame"; frame: Frame } | { kind: "note"; note: string } | { kind: "large" }> {
  const file = await asyncBufferFromFile(abs)
  let metadata: Awaited<ReturnType<typeof parquetMetadataAsync>>
  try {
    metadata = await parquetMetadataAsync(file)
  } catch (error: unknown) {
    // hyparquet throws a plain Error for a file that is not Parquet.
    return { kind: "note", note: `Could not read the Parquet file: ${errorText(error)}` }
  }
  const codecs = new Set(
    metadata.row_groups.flatMap((group) => group.columns.map((c) => c.meta_data?.codec ?? "")),
  )
  const unsupported = [...codecs].filter((codec) => UNSUPPORTED_CODECS.has(codec))
  if (unsupported.length > 0) {
    return {
      kind: "note",
      note: `Parquet compression ${unsupported.join(", ")} is not supported yet`,
    }
  }
  const firstGroup = Number(metadata.row_groups[0]?.total_compressed_size ?? 0n)
  if (!load && firstGroup > MAX_PARQUET_ROW_GROUP_BYTES) return { kind: "large" }
  const headers = parquetSchema(metadata).children.map((child) => child.element.name)
  const totalRows = Number(metadata.num_rows)
  const rows = await parquetReadObjects({
    file,
    metadata,
    rowStart: 0,
    rowEnd: Math.min(totalRows, maxRows),
    compressors: COMPRESSORS,
    useOffsetIndex: true,
  })
  const frame = frameFromValues({
    headers,
    columns: headers.map((header) => rows.map((row) => row[header] ?? null)),
    head: rows
      .slice(0, MAX_TABLE_ROWS)
      .map((row) => headers.map((header) => cellText(row[header]))),
    totalRows,
    indexColumn: null,
    text: cellText,
  })
  return { kind: "frame", frame }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One Parquet value as table text. Dates at midnight show as `YYYY-MM-DD`. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "number") return Number.isFinite(value) ? formatCell(value) : String(value)
  if (typeof value === "bigint" || typeof value === "boolean") return String(value)
  if (typeof value === "string") return value
  if (value instanceof Date) {
    const iso = value.toISOString()
    return iso.endsWith("T00:00:00.000Z")
      ? iso.slice(0, 10)
      : iso.replace("T", " ").replace(/\.000Z$/, "")
  }
  return JSON.stringify(value, (_, item: unknown) =>
    typeof item === "bigint" ? String(item) : item,
  )
}
