/**
 * A safe reader for Python pickles. It interprets the pickle opcodes itself and
 * never runs code: every GLOBAL / STACK_GLOBAL must name a class or function in
 * {@link ALLOWED_GLOBALS}, which only rebuild plain data (None, bools, numbers,
 * strings, bytes, lists, tuples, dicts, sets, NumPy arrays, and pandas
 * DataFrame / Series / Index). Any other name throws {@link PickleRefusedError}
 * naming it; malformed input throws {@link PickleFormatError}.
 *
 * Opcode reference: CPython `Lib/pickle.py` and `Lib/pickletools.py`.
 */

/** A pickle that names a class or function Analysis does not rebuild. */
export class PickleRefusedError extends Error {
  /** The refused `module.name`. */
  readonly className: string
  constructor(className: string) {
    super(`Stores Python objects of type ${className}, which Analysis does not open`)
    this.className = className
  }
}

/** A truncated, corrupt or unsupported pickle stream. */
export class PickleFormatError extends Error {}

// ── Python values ────────────────────────────────────────────────────────────

/** Any value the reader can produce. */
export type PyValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | PyValue[]
  | PyTuple
  | PyDict
  | PySet
  | PyBytes
  | PySlice
  | NdArray
  | NpDtype
  | PdIndex
  | PdFrame
  | PdSeries
  | PdArray
  | ArrowArray
  | ArrowType
  | PdBlock
  | PdBlockManager
  | PyGlobal
  | PyOpaque

export class PyTuple {
  constructor(readonly items: PyValue[]) {}
}

export class PySet {
  constructor(readonly items: PyValue[]) {}
}

export class PyBytes {
  constructor(readonly data: Uint8Array) {}
}

export class PySlice {
  constructor(
    readonly start: PyValue,
    readonly stop: PyValue,
    readonly step: PyValue,
  ) {}
}

/** A dict, keeping insertion order. Keys of a primitive type are unique. */
export class PyDict {
  readonly entries: Array<[PyValue, PyValue]> = []
  private readonly index = new Map<unknown, number>()

  set(key: PyValue, value: PyValue): void {
    const primitive = key === null || typeof key !== "object"
    const at = primitive ? this.index.get(key) : undefined
    if (at !== undefined) {
      const entry = this.entries[at]
      if (entry) entry[1] = value
      return
    }
    if (primitive) this.index.set(key, this.entries.length)
    this.entries.push([key, value])
  }

  get(key: string): PyValue | undefined {
    const at = this.index.get(key)
    return at === undefined ? undefined : this.entries[at]?.[1]
  }
}

/** A value that is kept only as its class name (e.g. a pandas frequency). */
export class PyOpaque {
  constructor(readonly className: string) {}
}

/** An allowlisted class or function, pushed by GLOBAL / STACK_GLOBAL. */
export class PyGlobal {
  constructor(
    readonly name: string,
    readonly spec: GlobalSpec,
  ) {}
}

/** What an allowlisted global does when called (REDUCE) or instantiated (NEWOBJ). */
interface GlobalSpec {
  call?: (args: PyValue[]) => PyValue
  newobj?: (args: PyValue[]) => PyValue
}

/** A value whose state is set by the BUILD opcode. */
interface Buildable {
  setState(state: PyValue): void
}

function isBuildable(value: PyValue): value is PyValue & Buildable {
  return (
    typeof value === "object" &&
    value !== null &&
    "setState" in value &&
    typeof value.setState === "function"
  )
}

// ── NumPy ────────────────────────────────────────────────────────────────────

const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

/** A plain NumPy dtype (no structured fields, no subarrays). */
export class NpDtype implements Buildable {
  /** Type kind: `b i u f c O U S M m`. */
  kind: string
  /** Bytes per element. */
  size: number
  littleEndian = LITTLE_ENDIAN_HOST
  /** The datetime / timedelta unit (`ns`, `s`, `D`, …), else null. */
  unit: string | null = null

  constructor(text: string) {
    const match = /^([biufcOUSMmV])(\d*)$/.exec(text)
    if (!match) throw new PickleFormatError(`Unknown NumPy dtype ${text}`)
    this.kind = match[1] ?? ""
    if (this.kind === "V") throw new PickleRefusedError("structured NumPy dtype")
    const digits = Number(match[2] || "0")
    this.size = this.kind === "U" ? digits * 4 : digits
    if (this.kind === "O") this.size = 8
    if (this.kind === "b" && this.size === 0) this.size = 1
    if (this.size <= 0 && this.kind !== "U" && this.kind !== "S") {
      throw new PickleFormatError(`NumPy dtype ${text} has no size`)
    }
  }

  /** NumPy's `dtype.__setstate__`: (version, endian, subarray, names, fields, elsize, alignment, flags[, metadata]). */
  setState(state: PyValue): void {
    const items = tupleItems(state, "dtype state")
    const endian = items[1]
    if (endian === ">") this.littleEndian = false
    else if (endian === "<") this.littleEndian = true
    if (items[2] !== null && items[2] !== undefined) {
      throw new PickleRefusedError("NumPy subarray dtype")
    }
    if (items[3] !== null && items[3] !== undefined) {
      throw new PickleRefusedError("structured NumPy dtype")
    }
    const elsize = items[5]
    if ((this.kind === "U" || this.kind === "S") && typeof elsize === "number" && elsize > 0) {
      this.size = elsize
    }
    const metadata = items[8]
    if (metadata instanceof PyTuple) {
      const unitTuple = metadata.items[1]
      if (unitTuple instanceof PyTuple && unitTuple.items[0] instanceof PyBytes) {
        this.unit = latin1(unitTuple.items[0].data)
      }
    }
  }

  /** The descr text, e.g. `<f8`. */
  get descr(): string {
    const order = this.size <= 1 || this.kind === "O" ? "|" : this.littleEndian ? "<" : ">"
    const width = this.kind === "U" ? this.size / 4 : this.size
    const unit = this.unit ? `[${this.unit}]` : ""
    return `${order}${this.kind}${width}${unit}`
  }
}

/** A NumPy array: raw bytes for plain dtypes, a list for object dtype. */
export class NdArray implements Buildable {
  shape: number[] = []
  dtype: NpDtype | null = null
  fortran = false
  raw: Uint8Array | null = null
  objects: PyValue[] | null = null

  /** NumPy's `ndarray.__setstate__`: (version, shape, dtype, is_fortran, rawdata). */
  setState(state: PyValue): void {
    const items = tupleItems(state, "ndarray state")
    const offset = items.length === 5 ? 1 : 0
    const shape = items[offset]
    const dtype = items[offset + 1]
    const fortran = items[offset + 2]
    const data = items[offset + 3]
    if (!(dtype instanceof NpDtype)) throw new PickleFormatError("ndarray state has no dtype")
    this.init(shapeOf(shape), dtype, fortran === true, data ?? null)
  }

  init(shape: number[], dtype: NpDtype, fortran: boolean, data: PyValue): void {
    this.shape = shape
    this.dtype = dtype
    this.fortran = fortran
    const count = shape.reduce((total, dimension) => total * dimension, 1)
    if (dtype.kind === "O") {
      if (!Array.isArray(data)) throw new PickleFormatError("object array data is not a list")
      if (data.length !== count) throw new PickleFormatError("object array has the wrong length")
      this.objects = data
      return
    }
    const bytes =
      data instanceof PyBytes ? data.data : typeof data === "string" ? latin1Bytes(data) : null
    if (!bytes) throw new PickleFormatError("array data is not bytes")
    if (bytes.length < count * dtype.size) throw new PickleFormatError("array data is truncated")
    this.raw = bytes
  }

  /** Number of elements. */
  get length(): number {
    return this.shape.reduce((total, dimension) => total * dimension, 1)
  }

  /** The element at a C-order position (row-major over {@link shape}). */
  at(position: number): PyValue {
    let index = position
    if (this.fortran && this.shape.length > 1) {
      // Convert the C-order position to the Fortran-order storage index.
      let remaining = position
      const coords: number[] = []
      for (let axis = this.shape.length - 1; axis >= 0; axis--) {
        const dimension = this.shape[axis] ?? 1
        coords[axis] = remaining % dimension
        remaining = Math.floor(remaining / dimension)
      }
      index = 0
      let stride = 1
      for (let axis = 0; axis < this.shape.length; axis++) {
        index += (coords[axis] ?? 0) * stride
        stride *= this.shape[axis] ?? 1
      }
    }
    if (this.objects) return this.objects[index] ?? null
    if (!this.raw || !this.dtype) return null
    return readElement(this.dtype, this.raw, index * this.dtype.size)
  }
}

/** Read one element of a plain dtype from raw bytes. */
export function readElement(dtype: NpDtype, raw: Uint8Array, offset: number): PyValue {
  const view = new DataView(raw.buffer, raw.byteOffset + offset, dtype.size)
  const le = dtype.littleEndian
  switch (dtype.kind) {
    case "b":
      return view.getUint8(0) !== 0
    case "f":
      if (dtype.size === 8) return view.getFloat64(0, le)
      if (dtype.size === 4) return view.getFloat32(0, le)
      if (dtype.size === 2) return float16(view.getUint16(0, le))
      break
    case "i":
      if (dtype.size === 8) return safeNumber(view.getBigInt64(0, le))
      if (dtype.size === 4) return view.getInt32(0, le)
      if (dtype.size === 2) return view.getInt16(0, le)
      if (dtype.size === 1) return view.getInt8(0)
      break
    case "u":
      if (dtype.size === 8) return safeNumber(view.getBigUint64(0, le))
      if (dtype.size === 4) return view.getUint32(0, le)
      if (dtype.size === 2) return view.getUint16(0, le)
      if (dtype.size === 1) return view.getUint8(0)
      break
    case "c": {
      if (dtype.size !== 8 && dtype.size !== 16) {
        throw new PickleRefusedError(`NumPy complex${dtype.size * 8} array`)
      }
      const half = dtype.size / 2
      const real = half === 8 ? view.getFloat64(0, le) : view.getFloat32(0, le)
      const imag = half === 8 ? view.getFloat64(half, le) : view.getFloat32(half, le)
      return `${real}${imag < 0 ? "-" : "+"}${Math.abs(imag)}j`
    }
    case "U": {
      let text = ""
      for (let i = 0; i < dtype.size; i += 4) {
        const code = view.getUint32(i, le)
        if (code === 0) break
        text += code > 0x10ffff ? "\ufffd" : String.fromCodePoint(code)
      }
      return text
    }
    case "S": {
      const bytes = raw.subarray(offset, offset + dtype.size)
      const end = bytes.indexOf(0)
      return latin1(end < 0 ? bytes : bytes.subarray(0, end))
    }
    case "M":
      return formatDatetime(view.getBigInt64(0, le), dtype.unit ?? "ns")
    case "m":
      return formatTimedelta(view.getBigInt64(0, le), dtype.unit ?? "ns")
  }
  throw new PickleFormatError(`Unsupported NumPy dtype ${dtype.descr}`)
}

/** The largest time a JavaScript Date can hold, in ms from 1970. */
const MAX_DATE_MS = 8.64e15

/** A record's own value for `key` (never one inherited from Object). */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

/** NumPy's NaT sentinel (the smallest int64). */
const NAT = -(2n ** 63n)
const UNIT_MS: Readonly<Record<string, number>> = {
  D: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1000,
  ms: 1,
  us: 1e-3,
  ns: 1e-6,
}

/** A datetime64 value as `YYYY-MM-DD` (midnight) or `YYYY-MM-DD HH:MM:SS(.fff)`. */
function formatDatetime(value: bigint, unit: string): string {
  if (value === NAT) return "NaT"
  const scale = own(UNIT_MS, unit)
  if (scale === undefined) return `${value} ${unit}`
  const ms = scale >= 1 ? Number(value) * scale : Number(value / BigInt(Math.round(1 / scale)))
  // Dates past what JavaScript can show (±275,000 years) stay as numbers.
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return `${value} ${unit}`
  const iso = new Date(ms).toISOString()
  if (iso.endsWith("T00:00:00.000Z")) return iso.slice(0, 10)
  return iso
    .replace("T", " ")
    .replace(/\.000Z$/, "")
    .replace(/Z$/, "")
}

function formatTimedelta(value: bigint, unit: string): string {
  if (value === NAT) return "NaT"
  return `${value} ${unit}`
}

/** IEEE half-precision bits to a number. */
function float16(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1
  const exponent = (bits >> 10) & 0x1f
  const fraction = bits & 0x3ff
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024)
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024)
}

function safeNumber(value: bigint): number {
  return Number(value)
}

function shapeOf(value: PyValue | undefined): number[] {
  const items = tupleItems(value ?? null, "shape")
  return items.map((item) => {
    const dimension = typeof item === "bigint" ? Number(item) : item
    if (typeof dimension !== "number" || !Number.isSafeInteger(dimension) || dimension < 0) {
      throw new PickleFormatError("invalid array shape")
    }
    return dimension
  })
}

// ── pandas ───────────────────────────────────────────────────────────────────

/** A pandas Index: a name and an element accessor. */
export class PdIndex {
  constructor(
    readonly name: PyValue,
    readonly length: number,
    readonly at: (position: number) => PyValue,
  ) {}
}

/** A pandas extension array (DatetimeArray, StringArray, …) backed by an ndarray. */
export class PdArray implements Buildable {
  values: NdArray | ArrowArray | null = null
  constructor(readonly className: string) {}

  /**
   * `NDArrayBacked.__setstate__`: (ndarray, dtype[, attrs]); or, for the
   * pyarrow-backed arrays, a dict whose `_pa_array` is the Arrow data.
   */
  setState(state: PyValue): void {
    if (state instanceof PyDict) {
      // `_pa_array` since pandas 2.1, `_data` before.
      const values = state.get("_pa_array") ?? state.get("_data")
      if (!(values instanceof ArrowArray)) {
        throw new PickleFormatError(`${this.className} state has no Arrow array`)
      }
      this.values = values
      return
    }
    const items = state instanceof PyTuple ? state.items : []
    const values = items.find((item): item is NdArray => item instanceof NdArray)
    if (!values) throw new PickleFormatError(`${this.className} state has no array`)
    this.values = values
  }
}

// ── pyarrow (the arrays behind pandas' Arrow-backed strings) ─────────────────

/** A pyarrow DataType, kept as its alias (from `pyarrow.lib.type_for_alias`). */
export class ArrowType {
  constructor(readonly alias: string) {}
}

/** Byte width and reader of the primitive Arrow types. */
const ARROW_PRIMITIVES: Readonly<
  Record<string, { width: number; read: (view: DataView, offset: number) => number }>
> = {
  int8: { width: 1, read: (v, o) => v.getInt8(o) },
  int16: { width: 2, read: (v, o) => v.getInt16(o, true) },
  int32: { width: 4, read: (v, o) => v.getInt32(o, true) },
  int64: { width: 8, read: (v, o) => Number(v.getBigInt64(o, true)) },
  uint8: { width: 1, read: (v, o) => v.getUint8(o) },
  uint16: { width: 2, read: (v, o) => v.getUint16(o, true) },
  uint32: { width: 4, read: (v, o) => v.getUint32(o, true) },
  uint64: { width: 8, read: (v, o) => Number(v.getBigUint64(o, true)) },
  float: { width: 4, read: (v, o) => v.getFloat32(o, true) },
  float32: { width: 4, read: (v, o) => v.getFloat32(o, true) },
  double: { width: 8, read: (v, o) => v.getFloat64(o, true) },
  float64: { width: 8, read: (v, o) => v.getFloat64(o, true) },
}
const ARROW_STRINGS: Readonly<Record<string, number>> = {
  string: 4,
  utf8: 4,
  large_string: 8,
  large_utf8: 8,
}

/**
 * A 1-D Arrow array of strings, numbers or bools, from its buffers (validity
 * bitmap, then offsets and data for strings, or values for numbers). Chunks of
 * a ChunkedArray are joined.
 */
export class ArrowArray {
  constructor(
    readonly length: number,
    readonly at: (position: number) => PyValue,
  ) {}
}

/** `pyarrow.lib._restore_array((type, length, null_count, offset, buffers, children, dictionary))`. */
function restoreArrowArray(args: PyValue[]): PyValue {
  const items = tupleItems(args[0] ?? null, "Arrow array state")
  const [type, lengthValue, , offsetValue, buffersValue] = items
  if (!(type instanceof ArrowType)) throw new PickleFormatError("Arrow array has no type")
  const length = toInt(lengthValue, 0)
  const offset = toInt(offsetValue, 0)
  const buffers = listItems(buffersValue ?? null, "Arrow buffers").map((buffer) => {
    if (buffer === null) return null
    if (buffer instanceof PyBytes) return buffer.data
    throw new PickleFormatError("Arrow buffer is not bytes")
  })
  const validity = buffers[0] ?? null
  const valid = (i: number): boolean => {
    if (!validity) return true
    const bit = i + offset
    return (((validity[bit >> 3] ?? 0) >> (bit & 7)) & 1) === 1
  }
  const view = (bytes: Uint8Array): DataView =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offsetWidth = own(ARROW_STRINGS, type.alias)
  if (offsetWidth !== undefined) {
    const offsets = buffers[1]
    const data = buffers[2] ?? new Uint8Array()
    if (!offsets || offsets.length < (offset + length + 1) * offsetWidth) {
      throw new PickleFormatError("Arrow string offsets are truncated")
    }
    const offsetView = view(offsets)
    const readOffset = (i: number): number =>
      offsetWidth === 8
        ? Number(offsetView.getBigInt64(i * 8, true))
        : offsetView.getInt32(i * 4, true)
    const decoder = new TextDecoder("utf-8")
    return new ArrowArray(length, (i) => {
      if (i < 0 || i >= length || !valid(i)) return null
      const start = readOffset(i + offset)
      const end = readOffset(i + offset + 1)
      if (start < 0 || end > data.length || end < start) {
        throw new PickleFormatError("Arrow string offsets are out of range")
      }
      return decoder.decode(data.subarray(start, end))
    })
  }
  if (type.alias === "bool") {
    const values = buffers[1] ?? new Uint8Array()
    return new ArrowArray(length, (i) => {
      if (i < 0 || i >= length || !valid(i)) return null
      const bit = i + offset
      return (((values[bit >> 3] ?? 0) >> (bit & 7)) & 1) === 1
    })
  }
  const primitive = own(ARROW_PRIMITIVES, type.alias)
  if (!primitive) throw new PickleRefusedError(`pyarrow array of type ${type.alias}`)
  const values = buffers[1]
  if (!values || values.length < (offset + length) * primitive.width) {
    throw new PickleFormatError("Arrow values are truncated")
  }
  const valuesView = view(values)
  return new ArrowArray(length, (i) =>
    i < 0 || i >= length || !valid(i)
      ? null
      : primitive.read(valuesView, (i + offset) * primitive.width),
  )
}

/** `pyarrow.lib.chunked_array(chunks, type)`: the chunks joined end to end. */
function chunkedArrowArray(args: PyValue[]): PyValue {
  const chunks = listItems(args[0] ?? null, "Arrow chunks").map((chunk) => {
    if (!(chunk instanceof ArrowArray)) throw new PickleFormatError("Arrow chunk is not an array")
    return chunk
  })
  const starts: number[] = []
  let length = 0
  for (const chunk of chunks) {
    starts.push(length)
    length += chunk.length
  }
  return new ArrowArray(length, (i) => {
    let chunk = chunks.length - 1
    while (chunk > 0 && (starts[chunk] ?? 0) > i) chunk--
    return chunks[chunk]?.at(i - (starts[chunk] ?? 0)) ?? null
  })
}

function arrowType(args: PyValue[]): PyValue {
  const [alias] = args
  if (typeof alias !== "string") throw new PickleFormatError("type_for_alias() of a non-string")
  return new ArrowType(alias)
}

function arrowBuffer(args: PyValue[]): PyValue {
  const [data] = args
  if (!(data instanceof PyBytes)) throw new PickleFormatError("py_buffer() of a non-bytes value")
  return data
}

/** One pandas block: a 2-D (items × rows) array and the item positions it holds. */
export class PdBlock {
  constructor(
    readonly values: NdArray | PdArray,
    readonly locs: number[],
  ) {}
}

/** A pandas BlockManager or SingleBlockManager: its axes and blocks. */
export class PdBlockManager implements Buildable {
  axes: PdIndex[] = []
  blocks: PdBlock[] = []
  constructor(readonly single: boolean) {}

  /** Old-style state: (axes, values, items, {"0.14.1": {axes, blocks}}). */
  setState(state: PyValue): void {
    const items = tupleItems(state, "BlockManager state")
    const extra = items[3]
    const modern = extra instanceof PyDict ? extra.get("0.14.1") : undefined
    if (!(modern instanceof PyDict)) {
      throw new PickleRefusedError("pandas BlockManager in a pre-0.14.1 format")
    }
    this.axes = listItems(modern.get("axes") ?? null, "BlockManager axes").map(asIndex)
    const length = this.axes[this.single ? 0 : 1]?.length ?? 0
    this.blocks = listItems(modern.get("blocks") ?? null, "BlockManager blocks").map((block) => {
      if (!(block instanceof PyDict)) throw new PickleFormatError("invalid pandas block")
      const values = block.get("values")
      if (!(values instanceof NdArray || values instanceof PdArray)) {
        throw new PickleFormatError("invalid pandas block values")
      }
      return new PdBlock(values, blockLocs(block.get("mgr_locs") ?? null, length))
    })
  }
}

/** Most columns a DataFrame may have (more is a corrupt or hostile pickle). */
const MAX_FRAME_COLUMNS = 1_000_000

/** A column of a frame (or the values of a series). */
export interface PdColumn {
  label: PyValue
  length: number
  at: (row: number) => PyValue
}

/** A pandas DataFrame: its row index and columns. */
export class PdFrame implements Buildable {
  index: PdIndex | null = null
  columns: PdColumn[] = []

  setState(state: PyValue): void {
    const manager = managerOf(state, "DataFrame")
    const [items, index] = manager.axes
    if (!items || !index) throw new PickleFormatError("DataFrame has no axes")
    this.index = index
    if (items.length > MAX_FRAME_COLUMNS) {
      throw new PickleFormatError(`DataFrame has ${items.length} columns`)
    }
    const columns: Array<PdColumn | undefined> = new Array(items.length)
    for (const block of manager.blocks) {
      block.locs.forEach((item, k) => {
        if (item < 0 || item >= items.length) {
          throw new PickleFormatError("pandas block column is out of range")
        }
        columns[item] = {
          label: items.at(item),
          length: index.length,
          at: (row) => blockValue(block.values, k, row, index.length, false),
        }
      })
    }
    this.columns = columns.map((column, item) => {
      if (!column) throw new PickleFormatError(`DataFrame column ${item} has no block`)
      return column
    })
  }
}

/** A pandas Series: its name, index and values. */
export class PdSeries implements Buildable {
  index: PdIndex | null = null
  values: PdColumn | null = null
  name: PyValue = null

  setState(state: PyValue): void {
    const manager = managerOf(state, "Series")
    const index = manager.axes[0]
    const block = manager.blocks[0]
    if (!index || !block) throw new PickleFormatError("Series has no values")
    this.index = index
    if (state instanceof PyDict) this.name = state.get("_name") ?? state.get("name") ?? null
    this.values = {
      label: this.name,
      length: index.length,
      at: (row) => blockValue(block.values, 0, row, index.length, true),
    }
  }
}

/** The `_mgr` of a DataFrame / Series state dict. */
function managerOf(state: PyValue, kind: string): PdBlockManager {
  const manager = state instanceof PyDict ? state.get("_mgr") : undefined
  if (manager instanceof PdBlockManager) return manager
  if (manager !== undefined) {
    throw new PickleRefusedError(`pandas ${kind} with a ${describeClass(manager)} manager`)
  }
  throw new PickleRefusedError(`pandas ${kind} in an old format`)
}

/** Value `row` of item `k` in a block (1-D for a Series, items × rows for a frame). */
function blockValue(
  values: NdArray | PdArray,
  k: number,
  row: number,
  rows: number,
  single: boolean,
): PyValue {
  const array = values instanceof PdArray ? values.values : values
  if (!array) return null
  if (single || array instanceof ArrowArray || array.shape.length === 1) return array.at(row)
  return array.at(k * rows + row)
}

/** A block's item positions from a slice or an int array. */
function blockLocs(value: PyValue, fallbackStop: number): number[] {
  if (value instanceof PySlice) {
    const start = toInt(value.start, 0)
    const stop = toInt(value.stop, fallbackStop)
    const step = toInt(value.step, 1)
    if (step <= 0) throw new PickleFormatError("invalid block slice")
    if ((stop - start) / step > MAX_FRAME_COLUMNS) {
      throw new PickleFormatError("pandas block has too many columns")
    }
    const locs: number[] = []
    for (let i = start; i < stop; i += step) locs.push(i)
    return locs
  }
  if (value instanceof NdArray) {
    return Array.from({ length: value.length }, (_, i) => toInt(value.at(i), 0))
  }
  throw new PickleFormatError("invalid block positions")
}

function toInt(value: PyValue | undefined, fallback: number): number {
  if (value === null || value === undefined) return fallback
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "number" && Number.isSafeInteger(value)) return value
  throw new PickleFormatError("expected an integer")
}

function asIndex(value: PyValue): PdIndex {
  if (value instanceof PdIndex) return value
  throw new PickleFormatError(`expected a pandas Index, got ${describeClass(value)}`)
}

/** `_new_Index(cls, d)` and `_new_DatetimeIndex(cls, d)`. */
function newIndex(args: PyValue[]): PyValue {
  const [cls, data] = args
  if (!(cls instanceof PyGlobal) || !(data instanceof PyDict)) {
    throw new PickleFormatError("invalid pandas Index arguments")
  }
  const name = data.get("name") ?? null
  if (INDEX_CLASSES.range.includes(cls.name)) {
    const start = toInt(data.get("start"), 0)
    const stop = toInt(data.get("stop"), 0)
    const step = toInt(data.get("step"), 1)
    if (step === 0) throw new PickleFormatError("RangeIndex step is 0")
    const length = Math.max(0, Math.ceil((stop - start) / step))
    return new PdIndex(name, length, (position) => start + position * step)
  }
  if (INDEX_CLASSES.plain.includes(cls.name)) {
    let values = data.get("data")
    if (values instanceof PdArray) values = values.values
    if (!(values instanceof NdArray || values instanceof ArrowArray)) {
      throw new PickleFormatError("pandas Index has no data")
    }
    const array = values
    return new PdIndex(name, array.length, (position) => array.at(position))
  }
  throw new PickleRefusedError(cls.name)
}

const INDEX_CLASSES = {
  range: ["pandas.core.indexes.range.RangeIndex", "pandas.RangeIndex"],
  plain: [
    "pandas.core.indexes.base.Index",
    "pandas.Index",
    "pandas.core.indexes.numeric.Int64Index",
    "pandas.core.indexes.numeric.UInt64Index",
    "pandas.core.indexes.numeric.Float64Index",
    "pandas.core.indexes.numeric.NumericIndex",
    "pandas.core.indexes.datetimes.DatetimeIndex",
    "pandas.DatetimeIndex",
    "pandas.core.indexes.timedeltas.TimedeltaIndex",
    "pandas.TimedeltaIndex",
  ],
}

const ARRAY_CLASSES = [
  "pandas.core.arrays.datetimes.DatetimeArray",
  "pandas.arrays.DatetimeArray",
  "pandas.core.arrays.timedeltas.TimedeltaArray",
  "pandas.arrays.TimedeltaArray",
  "pandas.core.arrays.string_.StringArray",
  "pandas.arrays.StringArray",
  "pandas.core.arrays.numpy_.PandasArray",
  "pandas.core.arrays.numpy_.NumpyExtensionArray",
  "pandas.arrays.NumpyExtensionArray",
]

/** pandas arrays backed by pyarrow: NEWOBJ, then a state dict with `_pa_array`. */
const ARROW_BACKED_CLASSES = [
  "pandas.core.arrays.string_arrow.ArrowStringArray",
  "pandas.arrays.ArrowStringArray",
  "pandas.core.arrays.arrow.array.ArrowExtensionArray",
  "pandas.arrays.ArrowExtensionArray",
]

// ── The allowlist ────────────────────────────────────────────────────────────

function makeSet(args: PyValue[]): PyValue {
  const [items] = args
  if (items === undefined) return new PySet([])
  if (Array.isArray(items)) return new PySet([...items])
  if (items instanceof PyTuple) return new PySet([...items.items])
  throw new PickleFormatError("set() of a non-list")
}

function reconstruct(args: PyValue[]): PyValue {
  const [cls] = args
  if (!(cls instanceof PyGlobal) || !NDARRAY_NAMES.includes(cls.name)) {
    throw new PickleRefusedError(cls instanceof PyGlobal ? cls.name : "a NumPy array subclass")
  }
  return new NdArray()
}

function npScalar(args: PyValue[]): PyValue {
  const [dtype, data] = args
  if (!(dtype instanceof NpDtype)) throw new PickleFormatError("scalar() without a dtype")
  if (dtype.kind === "O") return data ?? null
  const bytes =
    data instanceof PyBytes ? data.data : typeof data === "string" ? latin1Bytes(data) : null
  if (!bytes || bytes.length < dtype.size) throw new PickleFormatError("scalar() data is truncated")
  return readElement(dtype, bytes, 0)
}

function fromBuffer(args: PyValue[]): PyValue {
  const [buffer, dtype, shape, order] = args
  if (!(dtype instanceof NpDtype)) throw new PickleFormatError("_frombuffer() without a dtype")
  const array = new NdArray()
  array.init(shapeOf(shape ?? null), dtype, order === "F", buffer ?? null)
  return array
}

function makeDtype(args: PyValue[]): PyValue {
  const [text] = args
  if (typeof text !== "string") throw new PickleFormatError("dtype() of a non-string")
  return new NpDtype(text)
}

function makeSlice(args: PyValue[]): PyValue {
  if (args.length === 1) return new PySlice(null, args[0] ?? null, null)
  return new PySlice(args[0] ?? null, args[1] ?? null, args[2] ?? null)
}

function encodeLatin1(args: PyValue[]): PyValue {
  const [text, encoding] = args
  if (typeof text !== "string") throw new PickleFormatError("encode() of a non-string")
  if (encoding !== undefined && encoding !== "latin1" && encoding !== "latin-1") {
    throw new PickleFormatError(`encode() with ${String(encoding)}`)
  }
  return new PyBytes(latin1Bytes(text))
}

function makeBytearray(args: PyValue[]): PyValue {
  const [data, encoding] = args
  if (data === undefined) return new PyBytes(new Uint8Array())
  if (data instanceof PyBytes) return data
  if (typeof data === "string") return encodeLatin1([data, encoding ?? "latin1"])
  throw new PickleFormatError("bytearray() of an unsupported value")
}

function orderedDict(args: PyValue[]): PyValue {
  const dict = new PyDict()
  const [pairs] = args
  if (pairs === undefined) return dict
  for (const pair of listItems(pairs, "OrderedDict items")) {
    const [key, value] = tupleItems(pair, "OrderedDict item")
    dict.set(key ?? null, value ?? null)
  }
  return dict
}

function unpickleBlock(args: PyValue[]): PyValue {
  const [values, locs] = args
  if (!(values instanceof NdArray || values instanceof PdArray)) {
    throw new PickleRefusedError(`pandas block of ${describeClass(values ?? null)}`)
  }
  return new PdBlock(values, blockLocs(locs ?? null, 0))
}

function blockManager(single: boolean): GlobalSpec {
  return {
    newobj: () => new PdBlockManager(single),
    // pandas ≥ 1.3: BlockManager(blocks, axes) via __reduce__.
    call: (args) => {
      const manager = new PdBlockManager(single)
      manager.blocks = listItems(args[0] ?? null, "blocks").map((block) => {
        if (!(block instanceof PdBlock)) throw new PickleFormatError("invalid pandas block")
        return block
      })
      manager.axes = listItems(args[1] ?? null, "axes").map(asIndex)
      return manager
    },
  }
}

function ndArrayBacked(args: PyValue[]): PyValue {
  const [cls] = args
  if (!(cls instanceof PyGlobal) || !ARRAY_CLASSES.includes(cls.name)) {
    throw new PickleRefusedError(cls instanceof PyGlobal ? cls.name : "pandas extension array")
  }
  return new PdArray(cls.name)
}

const NDARRAY_NAMES = ["numpy.ndarray"]
const VALUE_ONLY: GlobalSpec = {}

/** Every `module.name` a pickle may name, and what it does. */
const ALLOWED_GLOBALS: ReadonlyMap<string, GlobalSpec> = new Map<string, GlobalSpec>([
  ["builtins.set", { call: makeSet }],
  ["builtins.frozenset", { call: makeSet }],
  ["__builtin__.set", { call: makeSet }],
  ["__builtin__.frozenset", { call: makeSet }],
  ["builtins.bytearray", { call: makeBytearray }],
  ["__builtin__.bytearray", { call: makeBytearray }],
  ["builtins.slice", { call: makeSlice }],
  ["__builtin__.slice", { call: makeSlice }],
  ["_codecs.encode", { call: encodeLatin1 }],
  ["collections.OrderedDict", { call: orderedDict, newobj: orderedDict }],
  ["numpy.ndarray", VALUE_ONLY],
  ["numpy.dtype", { call: makeDtype }],
  ["numpy.core.multiarray._reconstruct", { call: reconstruct }],
  ["numpy._core.multiarray._reconstruct", { call: reconstruct }],
  ["numpy.core.multiarray.scalar", { call: npScalar }],
  ["numpy._core.multiarray.scalar", { call: npScalar }],
  ["numpy.core.numeric._frombuffer", { call: fromBuffer }],
  ["numpy._core.numeric._frombuffer", { call: fromBuffer }],
  ["pandas.core.frame.DataFrame", { newobj: () => new PdFrame() }],
  ["pandas.DataFrame", { newobj: () => new PdFrame() }],
  ["pandas.core.series.Series", { newobj: () => new PdSeries() }],
  ["pandas.Series", { newobj: () => new PdSeries() }],
  ["pandas.core.internals.managers.BlockManager", blockManager(false)],
  ["pandas.core.internals.managers.SingleBlockManager", blockManager(true)],
  ["pandas._libs.internals._unpickle_block", { call: unpickleBlock }],
  ["pandas.core.indexes.base._new_Index", { call: newIndex }],
  ["pandas.core.indexes.datetimes._new_DatetimeIndex", { call: newIndex }],
  ["pandas._libs.arrays.__pyx_unpickle_NDArrayBacked", { call: ndArrayBacked }],
  ...[...INDEX_CLASSES.range, ...INDEX_CLASSES.plain, ...ARRAY_CLASSES].map(
    (name): [string, GlobalSpec] => [name, VALUE_ONLY],
  ),
  ...ARROW_BACKED_CLASSES.map((name): [string, GlobalSpec] => [
    name,
    { newobj: () => new PdArray(name) },
  ]),
  ["pyarrow.lib._restore_array", { call: restoreArrowArray }],
  ["pyarrow.lib.chunked_array", { call: chunkedArrowArray }],
  ["pyarrow.lib.type_for_alias", { call: arrowType }],
  ["pyarrow.lib.py_buffer", { call: arrowBuffer }],
  ...[
    "pandas.core.arrays.string_.StringDtype",
    "pandas.StringDtype",
    "pandas.core.dtypes.dtypes.ArrowDtype",
    "pandas.ArrowDtype",
  ].map((name): [string, GlobalSpec] => [name, { call: () => new PyOpaque(name) }]),
])

/** pandas frequency objects (`Day`, `Hour`, …): kept only as their name. */
const OPAQUE_MODULES = ["pandas._libs.tslibs.offsets."]

function resolveGlobal(module: string, name: string): PyGlobal {
  const full = `${module}.${name}`
  const spec = ALLOWED_GLOBALS.get(full)
  if (spec) return new PyGlobal(full, spec)
  if (OPAQUE_MODULES.some((prefix) => full.startsWith(prefix)) && /^\w+$/.test(name)) {
    return new PyGlobal(full, { call: () => new PyOpaque(full), newobj: () => new PyOpaque(full) })
  }
  throw new PickleRefusedError(full)
}

// ── The opcode interpreter ───────────────────────────────────────────────────

const MARK = Symbol("mark")
type StackItem = PyValue | typeof MARK

/**
 * Read one pickle from `data` (the bytes after a `.npy` header, or a whole
 * `.pkl` file). Throws {@link PickleRefusedError} or {@link PickleFormatError}.
 */
export function unpickle(data: Uint8Array): PyValue {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const decoder = new TextDecoder("utf-8")
  let pos = 0
  const stack: StackItem[] = []
  const marks: number[] = []
  // An array, not a Map: a pickle of millions of objects (e.g. NumPy scalars)
  // memoizes each one, past a Map's 2^24 entry limit.
  const memo: Array<PyValue | undefined> = []
  let memoCount = 0
  const memoSet = (key: number, value: PyValue): void => {
    if (!Number.isSafeInteger(key) || key < 0) throw new PickleFormatError("invalid memo key")
    if (memo[key] === undefined) memoCount++
    memo[key] = value
  }

  const need = (count: number): number => {
    if (count < 0 || pos + count > data.length) throw new PickleFormatError("pickle is truncated")
    const at = pos
    pos += count
    return at
  }
  const u8 = (): number => view.getUint8(need(1))
  const u16 = (): number => view.getUint16(need(2), true)
  const u32 = (): number => view.getUint32(need(4), true)
  const i32 = (): number => view.getInt32(need(4), true)
  const u64 = (): number => {
    const value = view.getBigUint64(need(8), true)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new PickleFormatError("length too large")
    return Number(value)
  }
  const bytes = (count: number): Uint8Array => {
    const at = need(count)
    return data.subarray(at, at + count)
  }
  const line = (): string => {
    const end = data.indexOf(0x0a, pos)
    if (end < 0) throw new PickleFormatError("pickle is truncated")
    const text = latin1(data.subarray(pos, end))
    pos = end + 1
    return text
  }
  const push = (value: PyValue): void => {
    stack.push(value)
  }
  const pop = (): PyValue => {
    if (stack.length === 0 || (marks.length > 0 && stack.length <= (marks.at(-1) ?? 0))) {
      throw new PickleFormatError("pickle stack underflow")
    }
    const value = stack.pop()
    if (value === MARK || value === undefined) throw new PickleFormatError("unexpected mark")
    return value
  }
  const top = (): PyValue => {
    const value = stack.at(-1)
    if (value === undefined || value === MARK) throw new PickleFormatError("pickle stack underflow")
    return value
  }
  const popMark = (): PyValue[] => {
    const at = marks.pop()
    if (at === undefined) throw new PickleFormatError("missing mark")
    const items = stack.splice(at) as PyValue[]
    stack.pop() // the mark itself
    return items
  }
  const memoGet = (key: number): PyValue => {
    const value = memo[key]
    if (value === undefined) throw new PickleFormatError(`memo key ${key} is missing`)
    return value
  }
  const callGlobal = (callable: PyValue, args: PyValue[], how: "call" | "newobj"): PyValue => {
    if (!(callable instanceof PyGlobal)) {
      throw new PickleFormatError(`cannot call ${describeClass(callable)}`)
    }
    const run = how === "call" ? callable.spec.call : callable.spec.newobj
    if (!run) throw new PickleRefusedError(callable.name)
    return run(args)
  }
  const appendItems = (target: PyValue, items: PyValue[]): void => {
    if (Array.isArray(target)) target.push(...items)
    else if (target instanceof PySet) target.items.push(...items)
    else throw new PickleFormatError(`cannot append to ${describeClass(target)}`)
  }
  const setItems = (target: PyValue, items: PyValue[]): void => {
    if (!(target instanceof PyDict)) {
      throw new PickleFormatError(`cannot set items on ${describeClass(target)}`)
    }
    if (items.length % 2 !== 0) throw new PickleFormatError("odd number of dict items")
    for (let i = 0; i < items.length; i += 2) target.set(items[i] ?? null, items[i + 1] ?? null)
  }

  for (;;) {
    const op = u8()
    switch (op) {
      case 0x80: // PROTO
        if (u8() > 5) throw new PickleFormatError("unsupported pickle protocol")
        break
      case 0x95: // FRAME
        u64()
        break
      case 0x2e: // STOP
        return pop()
      case 0x28: // MARK
        marks.push(stack.length + 1)
        stack.push(MARK)
        break
      case 0x30: // POP
        if (stack.at(-1) === MARK) {
          stack.pop()
          marks.pop()
        } else pop()
        break
      case 0x31: // POP_MARK
        popMark()
        break
      case 0x32: // DUP
        push(top())
        break
      case 0x4e: // NONE
        push(null)
        break
      case 0x88: // NEWTRUE
        push(true)
        break
      case 0x89: // NEWFALSE
        push(false)
        break
      case 0x49: {
        // INT (protocol 0; "00"/"01" are bools)
        const text = line()
        if (text === "00") push(false)
        else if (text === "01") push(true)
        else push(parseInteger(text))
        break
      }
      case 0x4c: // LONG
        push(parseInteger(line().replace(/L$/, "")))
        break
      case 0x4a: // BININT
        push(i32())
        break
      case 0x4b: // BININT1
        push(u8())
        break
      case 0x4d: // BININT2
        push(u16())
        break
      case 0x8a: // LONG1
        push(decodeLong(bytes(u8())))
        break
      case 0x8b: {
        // LONG4
        const length = i32()
        push(decodeLong(bytes(length)))
        break
      }
      case 0x46: // FLOAT
        push(Number.parseFloat(line()))
        break
      case 0x47: // BINFLOAT
        push(view.getFloat64(need(8), false))
        break
      case 0x53: // STRING
        push(parseQuoted(line()))
        break
      case 0x54: {
        // BINSTRING
        const length = i32()
        push(latin1(bytes(length)))
        break
      }
      case 0x55: // SHORT_BINSTRING
        push(latin1(bytes(u8())))
        break
      case 0x56: // UNICODE (raw-unicode-escape)
        push(rawUnicodeEscape(line()))
        break
      case 0x58: // BINUNICODE
        push(decoder.decode(bytes(u32())))
        break
      case 0x8c: // SHORT_BINUNICODE
        push(decoder.decode(bytes(u8())))
        break
      case 0x8d: // BINUNICODE8
        push(decoder.decode(bytes(u64())))
        break
      case 0x42: // BINBYTES
        push(new PyBytes(bytes(u32())))
        break
      case 0x43: // SHORT_BINBYTES
        push(new PyBytes(bytes(u8())))
        break
      case 0x8e: // BINBYTES8
        push(new PyBytes(bytes(u64())))
        break
      case 0x96: // BYTEARRAY8
        push(new PyBytes(bytes(u64())))
        break
      case 0x98: // READONLY_BUFFER
        break
      case 0x29: // EMPTY_TUPLE
        push(new PyTuple([]))
        break
      case 0x85: // TUPLE1
        push(new PyTuple([pop()]))
        break
      case 0x86: {
        // TUPLE2
        const b = pop()
        const a = pop()
        push(new PyTuple([a, b]))
        break
      }
      case 0x87: {
        // TUPLE3
        const c = pop()
        const b = pop()
        const a = pop()
        push(new PyTuple([a, b, c]))
        break
      }
      case 0x74: // TUPLE
        push(new PyTuple(popMark()))
        break
      case 0x5d: // EMPTY_LIST
        push([])
        break
      case 0x6c: // LIST
        push(popMark())
        break
      case 0x7d: // EMPTY_DICT
        push(new PyDict())
        break
      case 0x64: {
        // DICT
        const dict = new PyDict()
        setItems(dict, popMark())
        push(dict)
        break
      }
      case 0x8f: // EMPTY_SET
        push(new PySet([]))
        break
      case 0x91: // FROZENSET
        push(new PySet(popMark()))
        break
      case 0x61: {
        // APPEND
        const item = pop()
        appendItems(top(), [item])
        break
      }
      case 0x65: // APPENDS
      case 0x90: {
        // ADDITEMS
        const items = popMark()
        appendItems(top(), items)
        break
      }
      case 0x73: {
        // SETITEM
        const value = pop()
        const key = pop()
        setItems(top(), [key, value])
        break
      }
      case 0x75: {
        // SETITEMS
        const items = popMark()
        setItems(top(), items)
        break
      }
      case 0x67: // GET
        push(memoGet(Number.parseInt(line(), 10)))
        break
      case 0x68: // BINGET
        push(memoGet(u8()))
        break
      case 0x6a: // LONG_BINGET
        push(memoGet(u32()))
        break
      case 0x70: // PUT
        memoSet(Number.parseInt(line(), 10), top())
        break
      case 0x71: // BINPUT
        memoSet(u8(), top())
        break
      case 0x72: // LONG_BINPUT
        memoSet(u32(), top())
        break
      case 0x94: // MEMOIZE
        memoSet(memoCount, top())
        break
      case 0x63: {
        // GLOBAL
        const module = line()
        const name = line()
        push(resolveGlobal(module, name))
        break
      }
      case 0x93: {
        // STACK_GLOBAL
        const name = pop()
        const module = pop()
        if (typeof module !== "string" || typeof name !== "string") {
          throw new PickleFormatError("STACK_GLOBAL needs two strings")
        }
        push(resolveGlobal(module, name))
        break
      }
      case 0x52: {
        // REDUCE
        const args = pop()
        const callable = pop()
        push(callGlobal(callable, tupleItems(args, "REDUCE arguments"), "call"))
        break
      }
      case 0x81: {
        // NEWOBJ
        const args = pop()
        const cls = pop()
        push(callGlobal(cls, tupleItems(args, "NEWOBJ arguments"), "newobj"))
        break
      }
      case 0x92: {
        // NEWOBJ_EX
        pop() // kwargs
        const args = pop()
        const cls = pop()
        push(callGlobal(cls, tupleItems(args, "NEWOBJ_EX arguments"), "newobj"))
        break
      }
      case 0x62: {
        // BUILD
        const state = pop()
        const target = top()
        if (isBuildable(target)) target.setState(state)
        else if (!(target instanceof PyOpaque)) {
          throw new PickleFormatError(`cannot set the state of ${describeClass(target)}`)
        }
        break
      }
      case 0x69: {
        // INST
        const module = line()
        const name = line()
        const cls = resolveGlobal(module, name)
        push(callGlobal(cls, popMark(), "newobj"))
        break
      }
      case 0x6f: {
        // OBJ
        const [cls, ...args] = popMark()
        push(callGlobal(cls ?? null, args, "newobj"))
        break
      }
      case 0x50: // PERSID
      case 0x51: // BINPERSID
        throw new PickleRefusedError("persistent reference")
      case 0x82: // EXT1
      case 0x83: // EXT2
      case 0x84: // EXT4
        throw new PickleRefusedError("copyreg extension")
      case 0x97: // NEXT_BUFFER
        throw new PickleFormatError("pickle uses out-of-band buffers")
      default:
        throw new PickleFormatError(`unknown pickle opcode 0x${op.toString(16)} at byte ${pos - 1}`)
    }
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────

/** A short type name for messages. */
export function describeClass(value: PyValue): string {
  if (value === null) return "None"
  if (Array.isArray(value)) return "list"
  if (typeof value !== "object") return typeof value
  if (value instanceof PyGlobal) return value.name
  if (value instanceof PyOpaque) return value.className
  return value.constructor.name
}

function tupleItems(value: PyValue, what: string): PyValue[] {
  if (value instanceof PyTuple) return value.items
  if (Array.isArray(value)) return value
  throw new PickleFormatError(`${what} is not a tuple`)
}

function listItems(value: PyValue, what: string): PyValue[] {
  if (Array.isArray(value)) return value
  if (value instanceof PyTuple) return value.items
  throw new PickleFormatError(`${what} is not a list`)
}

function latin1(data: Uint8Array): string {
  let text = ""
  for (let i = 0; i < data.length; i += 4096) {
    text += String.fromCharCode(...data.subarray(i, i + 4096))
  }
  return text
}

function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

function parseInteger(text: string): number | bigint {
  if (!/^[+-]?\d+$/.test(text.trim())) throw new PickleFormatError(`invalid integer ${text}`)
  const value = BigInt(text.trim())
  return fitNumber(value)
}

function fitNumber(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value
}

/** Little-endian two's complement bytes (LONG1 / LONG4) to an integer. */
function decodeLong(data: Uint8Array): number | bigint {
  if (data.length === 0) return 0
  let value = 0n
  for (let i = data.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(data[i] ?? 0)
  if ((data[data.length - 1] ?? 0) & 0x80) value -= 1n << BigInt(data.length * 8)
  return fitNumber(value)
}

/** A protocol 0 STRING argument: a Python repr in single or double quotes. */
function parseQuoted(text: string): string {
  const quote = text[0]
  if ((quote !== "'" && quote !== '"') || text.at(-1) !== quote || text.length < 2) {
    throw new PickleFormatError("invalid STRING argument")
  }
  const body = text.slice(1, -1)
  return body.replace(/\\(x[0-9a-fA-F]{2}|[0-7]{1,3}|.)/g, (_, code: string) => {
    if (code[0] === "x") return String.fromCharCode(Number.parseInt(code.slice(1), 16))
    if (/^[0-7]/.test(code)) return String.fromCharCode(Number.parseInt(code, 8))
    const simple: Record<string, string> = {
      n: "\n",
      r: "\r",
      t: "\t",
      "\\": "\\",
      "'": "'",
      '"': '"',
    }
    return simple[code] ?? `\\${code}`
  })
}

/** Decode Python's raw-unicode-escape (`\uXXXX`, `\UXXXXXXXX`; other bytes are latin-1). */
function rawUnicodeEscape(text: string): string {
  return text.replace(
    /\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/g,
    (_, short?: string, long?: string) =>
      String.fromCodePoint(Number.parseInt(short ?? long ?? "0", 16)),
  )
}
