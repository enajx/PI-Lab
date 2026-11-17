import type { FileHandle } from "node:fs/promises"
import {
  type ArrayPreview,
  type ChartPreview,
  type DataFilePreview,
  formatCell,
  LARGE_FILE_BYTES,
  MAX_ARRAY_COLS,
  MAX_ARRAY_ROWS,
  MAX_CHART_POINTS,
  type MetadataPreview,
} from "./previewShapes"
import { previewPickle } from "./pythonPreview"

/**
 * NumPy `.npy` decoding over a {@link ByteReader}, shared by standalone
 * `.npy` files (read from disk) and the members of `.npz` zips.
 */

/** The 6 magic bytes that prefix every `.npy` file: `\x93NUMPY`. */
const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59] as const

/** Reader for one supported little/big-endian dtype, keyed by its descr suffix. */
interface NpyDtype {
  /** Byte width of one element. */
  width: number
  /** Read one element from `view` at `offset`. */
  read: (view: DataView, offset: number, littleEndian: boolean) => number
}

/** The numeric dtypes we decode (float + signed/unsigned int, 1–8 bytes). */
const NPY_DTYPES: Readonly<Record<string, NpyDtype>> = {
  f8: { width: 8, read: (v, o, le) => v.getFloat64(o, le) },
  f4: { width: 4, read: (v, o, le) => v.getFloat32(o, le) },
  i8: { width: 8, read: (v, o, le) => Number(v.getBigInt64(o, le)) },
  i4: { width: 4, read: (v, o, le) => v.getInt32(o, le) },
  i2: { width: 2, read: (v, o, le) => v.getInt16(o, le) },
  i1: { width: 1, read: (v, o) => v.getInt8(o) },
  u8: { width: 8, read: (v, o, le) => Number(v.getBigUint64(o, le)) },
  u4: { width: 4, read: (v, o, le) => v.getUint32(o, le) },
  u2: { width: 2, read: (v, o, le) => v.getUint16(o, le) },
  u1: { width: 1, read: (v, o) => v.getUint8(o) },
}

/** A `.npy` file's header fields and where its data starts. */
export interface NpyHeader {
  descr: string
  fortranOrder: boolean
  /** `[n]` or `[rows, cols]` (higher ranks are refused by the parser). */
  shape: number[]
  /** Byte offset of the first data byte. */
  dataOffset: number
}

/** A 1-D/2-D numeric `.npy` source whose shown cells were read from disk. */
interface DecodedNpy {
  /** Array shape: `[n]` for 1-D, `[rows, cols]` for 2-D. */
  shape: number[]
  /** Original dtype descr (e.g. `<f8`). */
  dtype: string
  /** Read one shown logical cell. */
  readValue: (row: number, col: number) => number
}

/** Parse the `.npy` header dict text into descr / fortran_order / shape. */
function parseNpyHeader(
  header: string,
): { descr: string; fortranOrder: boolean; shape: number[] } | null {
  const descr = header.match(/'descr'\s*:\s*'([^']+)'/)
  const fortran = header.match(/'fortran_order'\s*:\s*(True|False)/)
  const shapeText = header.match(/'shape'\s*:\s*\(([^)]*)\)/)
  if (!descr || !fortran || !shapeText) return null
  const rawShape = (shapeText[1] ?? "").trim()
  if (rawShape === "")
    return { descr: descr[1] ?? "", fortranOrder: fortran[1] === "True", shape: [] }
  const firstComma = rawShape.indexOf(",")
  if (firstComma < 0) return null
  const secondComma = rawShape.indexOf(",", firstComma + 1)
  if (secondComma >= 0 && rawShape.slice(secondComma + 1).trim() !== "") return null
  const first = rawShape.slice(0, firstComma).trim()
  const second = rawShape.slice(firstComma + 1, secondComma >= 0 ? secondComma : undefined).trim()
  if (secondComma >= 0 && second === "") return null
  if (!/^\d+$/.test(first) || (second !== "" && !/^\d+$/.test(second))) return null
  const shape = second === "" ? [Number(first)] : [Number(first), Number(second)]
  if (!shape.every((dimension) => Number.isSafeInteger(dimension) && dimension >= 0)) return null
  return { descr: descr[1] ?? "", fortranOrder: fortran[1] === "True", shape }
}

/**
 * Parse the magic, version and header dict of a `.npy` prefix. Returns null
 * for a bad magic, an unsupported version, a header past the end of `buf`, or
 * a header the parser refuses (see {@link parseNpyHeader}).
 *
 * Format spec: https://numpy.org/doc/stable/reference/generated/numpy.lib.format.html
 */
export function parseNpyPrefix(buf: Buffer): NpyHeader | null {
  if (buf.length < 10) return null
  for (let i = 0; i < NPY_MAGIC.length; i++) {
    if (buf[i] !== NPY_MAGIC[i]) return null
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const major = buf[6]
  const minor = buf[7]
  let headerLen: number
  let headerStart: number
  if (major === 1 && minor === 0) {
    headerLen = view.getUint16(8, true)
    headerStart = 10
  } else if ((major === 2 || major === 3) && minor === 0) {
    if (buf.length < 12) return null
    headerLen = view.getUint32(8, true)
    headerStart = 12
  } else {
    return null
  }
  const dataOffset = headerStart + headerLen
  if (!Number.isSafeInteger(dataOffset) || dataOffset > buf.length) return null
  const parsed = parseNpyHeader(buf.toString("utf8", headerStart, dataOffset))
  return parsed ? { ...parsed, dataOffset } : null
}

/** Max bytes read for a `.npy` header (longer headers fall back to metadata). */
export const MAX_NPY_HEADER_BYTES = 1024 * 1024

/**
 * Reads `length` bytes at `position` of a `.npy` source (fewer at its end):
 * a file on disk or a member of a `.npz` held in memory.
 */
export type ByteReader = (position: number, length: number) => Promise<Buffer>

/** A {@link ByteReader} over an open file. */
export function fileReader(file: FileHandle): ByteReader {
  return async (position, length) => {
    const buffer = Buffer.alloc(Math.max(0, length))
    let done = 0
    while (done < buffer.length) {
      const { bytesRead } = await file.read(buffer, done, buffer.length - done, position + done)
      if (bytesRead === 0) break
      done += bytesRead
    }
    return buffer.subarray(0, done)
  }
}

/** A {@link ByteReader} over bytes in memory. */
export function bufferReader(bytes: Buffer): ByteReader {
  return async (position, length) => bytes.subarray(position, position + Math.max(0, length))
}

/**
 * Preview a `.npy` array of `size` bytes, reading only what is shown. A 1-D
 * numeric array becomes a {@link ChartPreview} (value vs. row index, strided
 * to {@link MAX_CHART_POINTS}, its series named `label`); a 2-D one a bounded
 * {@link ArrayPreview} grid. Only the header and the shown cells are read, so
 * the size does not matter. An object array (`|O`) holds a pickle, read whole
 * (above the pickle size limit only with `load`, else a `large` preview) by
 * the safe unpickler. Anything malformed or unsupported degrades to a
 * metadata card with a note (no throw).
 */
export async function previewNpyBytes(
  read: ByteReader,
  size: number,
  label: string,
  load: boolean,
  meta: (note?: string) => MetadataPreview,
): Promise<DataFilePreview> {
  const head = await read(0, Math.min(size, MAX_NPY_HEADER_BYTES))
  const header = parseNpyPrefix(head)
  if (!header) return meta("Could not decode .npy array")
  if (/^[|<>=]O\d*$/.test(header.descr)) {
    const limit = LARGE_FILE_BYTES.pickle
    if (!load && limit !== null && size > limit) {
      return { type: "large", kind: "npy", size, huge: false, partial: null }
    }
    const payload = await read(header.dataOffset, size - header.dataOffset)
    return previewPickle(payload, label, meta)
  }
  const decoded = await readNpyCells(read, header, size)
  if (!decoded) return meta("Could not decode .npy array")
  if (decoded.shape.length === 1) return npyChart(decoded, label)
  return npyArray(decoded)
}

/** Bytes between two shown cells below which one read covers both. */
const NPY_READ_GAP = 4096

/**
 * Read the cells a preview shows (a strided series, or the top-left grid) of
 * a numeric 1-D/2-D array. Null when the dtype is unsupported, the shape is a
 * scalar, or the file is shorter than the header says.
 */
async function readNpyCells(
  read: ByteReader,
  header: NpyHeader,
  size: number,
): Promise<DecodedNpy | null> {
  if (header.shape.length === 0 || header.shape.length > 2) return null
  const marker = header.descr[0]
  if (marker !== "<" && marker !== ">" && marker !== "|" && marker !== "=") return null
  const littleEndian =
    marker === "<" ||
    marker === "|" ||
    (marker === "=" && new Uint8Array(new Uint16Array([1]).buffer)[0] === 1)
  const dtype = NPY_DTYPES[header.descr.slice(1)]
  if (!dtype) return null
  let total = 1
  for (const dimension of header.shape) {
    total *= dimension
    if (!Number.isSafeInteger(total)) return null
  }
  const byteCount = total * dtype.width
  if (!Number.isSafeInteger(byteCount) || byteCount > size - header.dataOffset) return null

  const [rowCount = 0, colCount = 1] = header.shape
  const storageIndex = (row: number, col: number): number =>
    header.fortranOrder && header.shape.length === 2 ? col * rowCount + row : row * colCount + col
  const wanted: number[] = []
  if (header.shape.length === 1) {
    for (let row = 0; row < rowCount; row += chartStride(rowCount)) wanted.push(row)
  } else {
    const shownRows = Math.min(rowCount, MAX_ARRAY_ROWS)
    const shownCols = Math.min(colCount, MAX_ARRAY_COLS)
    for (let row = 0; row < shownRows; row++) {
      for (let col = 0; col < shownCols; col++) wanted.push(storageIndex(row, col))
    }
    wanted.sort((a, b) => a - b)
  }

  const values = new Map<number, number>()
  let start = 0
  while (start < wanted.length) {
    let end = start
    while (
      end + 1 < wanted.length &&
      ((wanted[end + 1] ?? 0) - (wanted[end] ?? 0)) * dtype.width <= NPY_READ_GAP
    ) {
      end++
    }
    const first = wanted[start] ?? 0
    const last = wanted[end] ?? 0
    const bytes = await read(
      header.dataOffset + first * dtype.width,
      (last - first + 1) * dtype.width,
    )
    if (bytes.length < (last - first + 1) * dtype.width) return null
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let i = start; i <= end; i++) {
      const index = wanted[i] ?? 0
      values.set(index, dtype.read(view, (index - first) * dtype.width, littleEndian))
    }
    start = end + 1
  }
  return {
    shape: header.shape,
    dtype: header.descr,
    readValue: (row, col) => values.get(storageIndex(row, col)) ?? Number.NaN,
  }
}

/** The stride that brings `count` points down to at most {@link MAX_CHART_POINTS}. */
function chartStride(count: number): number {
  return count > MAX_CHART_POINTS ? Math.ceil(count / MAX_CHART_POINTS) : 1
}

/** A 1-D `.npy` array → a single-series line chart over its row index. */
function npyChart(decoded: DecodedNpy, label: string): ChartPreview {
  const count = decoded.shape[0] ?? 0
  const stride = chartStride(count)
  const x: number[] = []
  const values: Array<number | null> = []
  for (let row = 0; row < count; row += stride) {
    x.push(row)
    const value = decoded.readValue(row, 0)
    values.push(Number.isFinite(value) ? value : null)
  }
  return { type: "chart", xLabel: "index", x, series: [{ label, values }], truncated: stride > 1 }
}

/** A 2-D `.npy` array → a bounded grid (rows × columns, both capped). */
function npyArray(decoded: DecodedNpy): ArrayPreview {
  const [rowCount = 0, colCount = 0] = decoded.shape
  const shownCols = Math.min(colCount, MAX_ARRAY_COLS)
  const shownRows = Math.min(rowCount, MAX_ARRAY_ROWS)

  const columns = Array.from({ length: shownCols }, (_, c) => `c${c}`)
  const rows: string[][] = []
  for (let r = 0; r < shownRows; r++) {
    const row: string[] = []
    for (let c = 0; c < shownCols; c++) row.push(formatCell(decoded.readValue(r, c)))
    rows.push(row)
  }

  return {
    type: "array",
    dtype: decoded.dtype,
    shape: decoded.shape,
    columns,
    rows,
    truncated: rowCount > MAX_ARRAY_ROWS || colCount > MAX_ARRAY_COLS,
  }
}
