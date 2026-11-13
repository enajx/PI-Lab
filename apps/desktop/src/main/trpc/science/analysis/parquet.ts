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
  MAX_TABLE_ROWS,
  type MetadataPreview,
} from "./previewShapes"

/**
 * Parquet previews with hyparquet (pure JavaScript). Only the footer and the
 * pages holding the first {@link MAX_TABLE_ROWS} rows are read; the table
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
  const file = await asyncBufferFromFile(abs)
  let metadata: Awaited<ReturnType<typeof parquetMetadataAsync>>
  try {
    metadata = await parquetMetadataAsync(file)
  } catch (error: unknown) {
    // hyparquet throws a plain Error for a file that is not Parquet.
    return meta(`Could not read the Parquet file: ${errorText(error)}`)
  }
  const codecs = new Set(
    metadata.row_groups.flatMap((group) => group.columns.map((c) => c.meta_data?.codec ?? "")),
  )
  const unsupported = [...codecs].filter((codec) => UNSUPPORTED_CODECS.has(codec))
  if (unsupported.length > 0) {
    return meta(`Parquet compression ${unsupported.join(", ")} is not supported yet`)
  }
  const firstGroup = Number(metadata.row_groups[0]?.total_compressed_size ?? 0n)
  if (!load && firstGroup > MAX_PARQUET_ROW_GROUP_BYTES)
    return { type: "large", kind: "parquet", size }
  const headers = parquetSchema(metadata).children.map((child) => child.element.name)
  const totalRows = Number(metadata.num_rows)
  const rows = await parquetReadObjects({
    file,
    metadata,
    rowStart: 0,
    rowEnd: Math.min(totalRows, MAX_TABLE_ROWS),
    compressors: COMPRESSORS,
    useOffsetIndex: true,
  })
  return {
    type: "table",
    headers,
    rows: rows.map((row) => headers.map((header) => cellText(row[header]))),
    totalRows,
    truncated: totalRows > MAX_TABLE_ROWS,
  }
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
