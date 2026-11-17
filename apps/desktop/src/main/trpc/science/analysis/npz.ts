import { open } from "node:fs/promises"
import { constants, inflateRawSync } from "node:zlib"
import {
  type ByteReader,
  bufferReader,
  fileReader,
  MAX_NPY_HEADER_BYTES,
  parseNpyPrefix,
  previewNpyBytes,
} from "./npy"
import {
  type DataFilePreview,
  type DatasetEntry,
  type DatasetsPreview,
  LARGE_FILE_BYTES,
  type MetadataPreview,
} from "./previewShapes"

/**
 * NumPy zip (`.npz`) previews, like HDF5 and SQLite: a `datasets` preview
 * listing the arrays inside (name without `.npy`, shape, dtype) and the
 * chosen one (else the first) previewed as a standalone `.npy` would be. Only
 * the zip's central directory, each array's header and the chosen array are
 * read. Stored members (`np.savez`) are read in place like a `.npy` file;
 * deflated members (`np.savez_compressed`) are decompressed whole, so one over
 * the pickle size limit (32 MiB) waits for Load.
 *
 * Zip format: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 */

/** Max arrays listed for one file. */
export const MAX_NPZ_ARRAYS = 500
/** Max central directory bytes read (enough for many thousands of members). */
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024
/** Compressed bytes inflated to read one array's header for the list. */
const LIST_HEADER_BYTES = 64 * 1024

const EOCD_SIGNATURE = 0x06054b50
const EOCD_BYTES = 22
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_LOCATOR_BYTES = 20
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_EXTRA_ID = 0x0001
const U16_MAX = 0xffff
const U32_MAX = 0xffffffff

/** One member of a zip, from its central directory record. */
interface ZipEntry {
  name: string
  /** 0 stored, 8 deflate; others are not read. */
  method: number
  encrypted: boolean
  compressedSize: number
  uncompressedSize: number
  /** Offset of the member's local header. */
  localOffset: number
}

/** The members of a zip, or why it is not one. */
type ZipDirectory =
  | { kind: "ok"; entries: ZipEntry[]; truncated: boolean }
  | { kind: "error"; reason: string }

/** An array member of a `.npz` with its listed shape and dtype. */
interface NpzArray {
  entry: ZipEntry
  listed: DatasetEntry
}

/** Preview a `.npz` file of `size` bytes: its arrays, and the chosen one (else the first). */
export async function previewNpz(
  abs: string,
  size: number,
  array: string | null,
  load: boolean,
  meta: (note?: string) => MetadataPreview,
): Promise<DataFilePreview> {
  const file = await open(abs, "r")
  try {
    const read = fileReader(file)
    const directory = await readZipDirectory(read, size)
    if (directory.kind === "error") return meta(`Not a zip file: ${directory.reason}`)
    const arrays: NpzArray[] = []
    for (const entry of directory.entries) {
      if (!entry.name.endsWith(".npy")) continue
      arrays.push({ entry, listed: await listArray(read, entry) })
    }
    if (arrays.length === 0) return meta("This .npz file has no arrays")
    const selected = array ?? arrays[0]?.listed.path ?? ""
    const chosen = arrays.find((item) => item.listed.path === selected)
    if (!chosen) return meta(`No array ${selected} in this file`)
    const datasets = arrays.map((item) => item.listed)
    const shell = (preview: DatasetsPreview["preview"]): DatasetsPreview => ({
      type: "datasets",
      datasets,
      truncated: directory.truncated,
      selected,
      preview,
    })
    const needsLoad = (): DataFilePreview => ({
      type: "large",
      kind: "npz",
      size: chosen.entry.uncompressedSize,
      huge: false,
      partial: shell(meta(`Array ${selected} is large; Load reads it whole`)),
    })

    const entry = chosen.entry
    if (entry.encrypted) return shell(meta(`Array ${selected} is encrypted`))
    if (entry.method !== 0 && entry.method !== 8) {
      return shell(meta(`Array ${selected} uses zip compression method ${entry.method}, not read`))
    }
    const dataStart = await memberDataStart(read, entry)
    if (dataStart === null) return shell(meta(`Array ${selected}: bad zip local header`))
    let member: ByteReader
    if (entry.method === 0) {
      member = async (position, length) =>
        read(dataStart + position, Math.min(length, entry.uncompressedSize - position))
    } else {
      const limit = LARGE_FILE_BYTES.pickle
      if (!load && limit !== null && entry.uncompressedSize > limit) return needsLoad()
      const bytes = inflateRawSync(await read(dataStart, entry.compressedSize))
      if (bytes.length !== entry.uncompressedSize) {
        return shell(meta(`Array ${selected}: decompressed size does not match the zip`))
      }
      member = bufferReader(bytes)
    }
    const preview = await previewNpyBytes(member, entry.uncompressedSize, selected, load, meta)
    if (preview.type === "large") return needsLoad()
    if (preview.type === "datasets") throw new Error("a .npy member cannot hold datasets")
    return shell(preview)
  } finally {
    await file.close()
  }
}

/** An array's name, shape and dtype from its `.npy` header (unknown if unreadable). */
async function listArray(read: ByteReader, entry: ZipEntry): Promise<DatasetEntry> {
  const path = entry.name.slice(0, -".npy".length)
  const unknown: DatasetEntry = { path, shape: [], dtype: "unknown" }
  if (entry.encrypted || (entry.method !== 0 && entry.method !== 8)) return unknown
  const dataStart = await memberDataStart(read, entry)
  if (dataStart === null) return unknown
  let head: Buffer
  if (entry.method === 0) {
    head = await read(dataStart, Math.min(entry.compressedSize, MAX_NPY_HEADER_BYTES))
  } else {
    // A cut deflate stream: SYNC_FLUSH returns what it decodes instead of failing at the cut.
    const compressed = await read(dataStart, Math.min(entry.compressedSize, LIST_HEADER_BYTES))
    head = inflateRawSync(compressed, { finishFlush: constants.Z_SYNC_FLUSH })
  }
  const header = parseNpyPrefix(head)
  return header ? { path, shape: header.shape, dtype: header.descr } : unknown
}

/** Offset of a member's data, after its local header; null for a bad header. */
async function memberDataStart(read: ByteReader, entry: ZipEntry): Promise<number | null> {
  const local = await read(entry.localOffset, 30)
  if (local.length < 30 || local.readUInt32LE(0) !== LOCAL_SIGNATURE) return null
  return entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
}

/** A little-endian u64 as a number; null above 2^53. */
function u64(buf: Buffer, offset: number): number | null {
  const value = Number(buf.readBigUInt64LE(offset))
  return Number.isSafeInteger(value) ? value : null
}

/**
 * List a zip's members from its central directory, found through the
 * end-of-central-directory record at the end of the file (and its Zip64
 * record when there is one). At most {@link MAX_NPZ_ARRAYS} members.
 */
async function readZipDirectory(read: ByteReader, size: number): Promise<ZipDirectory> {
  const tailStart = Math.max(0, size - (EOCD_BYTES + U16_MAX))
  const tail = await read(tailStart, size - tailStart)
  let eocd = -1
  for (let i = tail.length - EOCD_BYTES; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return { kind: "error", reason: "no end of central directory record" }
  let total = tail.readUInt16LE(eocd + 10)
  let directorySize = tail.readUInt32LE(eocd + 12)
  let directoryOffset = tail.readUInt32LE(eocd + 16)

  const locatorAt = tailStart + eocd - ZIP64_LOCATOR_BYTES
  if (locatorAt >= 0) {
    const locator = await read(locatorAt, ZIP64_LOCATOR_BYTES)
    if (
      locator.length === ZIP64_LOCATOR_BYTES &&
      locator.readUInt32LE(0) === ZIP64_LOCATOR_SIGNATURE
    ) {
      const recordAt = u64(locator, 8)
      const record = recordAt === null ? Buffer.alloc(0) : await read(recordAt, 56)
      if (record.length < 56 || record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
        return { kind: "error", reason: "bad Zip64 end of central directory record" }
      }
      const total64 = u64(record, 32)
      const size64 = u64(record, 40)
      const offset64 = u64(record, 48)
      if (total64 === null || size64 === null || offset64 === null) {
        return { kind: "error", reason: "Zip64 sizes too large" }
      }
      total = total64
      directorySize = size64
      directoryOffset = offset64
    }
  }
  if (total === U16_MAX || directorySize === U32_MAX || directoryOffset === U32_MAX) {
    return { kind: "error", reason: "missing Zip64 end of central directory record" }
  }
  if (directoryOffset + directorySize > size) {
    return { kind: "error", reason: "central directory past the end of the file" }
  }

  const directory = await read(
    directoryOffset,
    Math.min(directorySize, MAX_CENTRAL_DIRECTORY_BYTES),
  )
  const entries: ZipEntry[] = []
  let at = 0
  while (entries.length < Math.min(total, MAX_NPZ_ARRAYS) && at + 46 <= directory.length) {
    if (directory.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      return { kind: "error", reason: "bad central directory record" }
    }
    const nameLength = directory.readUInt16LE(at + 28)
    const extraLength = directory.readUInt16LE(at + 30)
    const commentLength = directory.readUInt16LE(at + 32)
    const end = at + 46 + nameLength + extraLength + commentLength
    if (end > directory.length) break
    const entry: ZipEntry = {
      name: directory.toString("utf8", at + 46, at + 46 + nameLength),
      method: directory.readUInt16LE(at + 10),
      encrypted: (directory.readUInt16LE(at + 8) & 1) === 1,
      compressedSize: directory.readUInt32LE(at + 20),
      uncompressedSize: directory.readUInt32LE(at + 24),
      localOffset: directory.readUInt32LE(at + 42),
    }
    const zip64 = applyZip64Extra(
      entry,
      directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength),
    )
    if (!zip64) return { kind: "error", reason: `bad Zip64 sizes for ${entry.name}` }
    entries.push(entry)
    at = end
  }
  return { kind: "ok", entries, truncated: entries.length < total }
}

/**
 * Replace the 32-bit fields set to 0xFFFFFFFF with the 64-bit values from the
 * Zip64 extra field (uncompressed, compressed, local offset, in that order).
 * False when a needed value is missing or too large.
 */
function applyZip64Extra(entry: ZipEntry, extra: Buffer): boolean {
  const fields = ["uncompressedSize", "compressedSize", "localOffset"] as const
  const needed = fields.filter((field) => entry[field] === U32_MAX)
  if (needed.length === 0) return true
  let at = 0
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at)
    const length = extra.readUInt16LE(at + 2)
    if (id === ZIP64_EXTRA_ID) {
      if (length < needed.length * 8 || at + 4 + length > extra.length) return false
      for (const [i, field] of needed.entries()) {
        const value = u64(extra, at + 4 + i * 8)
        if (value === null) return false
        entry[field] = value
      }
      return true
    }
    at += 4 + length
  }
  return false
}
