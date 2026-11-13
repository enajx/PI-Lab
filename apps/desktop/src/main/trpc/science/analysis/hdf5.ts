import { open } from "node:fs/promises"
import type { Dataset, Group } from "h5wasm"
import {
  type DataFilePreview,
  type DatasetEntry,
  type DatasetsPreview,
  downsampleChart,
  formatCell,
  MAX_ARRAY_COLS,
  MAX_ARRAY_ROWS,
  MAX_CHART_POINTS,
  MAX_TABLE_ROWS,
  type MetadataPreview,
} from "./previewShapes"

/**
 * HDF5 (`.h5`, `.hdf5`) previews with h5wasm (the HDF5 C library compiled to
 * WebAssembly; its Node build reads the file from disk as needed, so only the
 * listed metadata and the shown slice are read). The preview lists the
 * datasets and previews one: a 1-D numeric dataset as a strided chart, a 2-D
 * one as a grid, a 1-D compound (table) dataset as a table, strings as a grid.
 */

/** Max datasets listed for one file. */
export const MAX_HDF5_DATASETS = 500

type H5Module = typeof import("h5wasm")
let h5wasm: Promise<H5Module> | null = null

/**
 * Load h5wasm once. Its Emscripten start-up checks `navigator` to decide it
 * runs in a browser; Node (and so Electron main and its workers) defines one,
 * so it is hidden while the module starts, as the h5wasm README advises.
 */
function loadH5wasm(): Promise<H5Module> {
  if (!h5wasm) {
    h5wasm = (async () => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator")
      if (descriptor?.configurable) {
        Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true })
      }
      try {
        const module: H5Module = await import("h5wasm/node")
        await module.ready
        return module
      } finally {
        if (descriptor?.configurable) Object.defineProperty(globalThis, "navigator", descriptor)
      }
    })()
  }
  return h5wasm
}

/** Preview an HDF5 file: its datasets and the chosen one (else the first). */
export async function previewHdf5(
  abs: string,
  dataset: string | null,
  meta: (note?: string) => MetadataPreview,
): Promise<DataFilePreview> {
  if (!(await hasHdf5Signature(abs))) {
    return meta("Could not read the HDF5 file: no HDF5 signature")
  }
  const module = await loadH5wasm()
  const file = new module.File(abs, "r")
  try {
    const datasets: DatasetEntry[] = []
    const truncated = listDatasets(module, file, "", datasets)
    if (datasets.length === 0) return meta("This HDF5 file has no datasets")
    const selected = dataset ?? datasets[0]?.path ?? ""
    const entity = file.get(selected)
    if (!(entity instanceof module.Dataset)) {
      return meta(`No dataset ${selected} in this file`)
    }
    const preview: DatasetsPreview = {
      type: "datasets",
      datasets,
      truncated,
      selected,
      preview: safePreviewDataset(entity, selected),
    }
    return preview
  } finally {
    file.close()
  }
}

/** The 8-byte HDF5 signature, found at offset 0 or after a user block of 512 × 2ⁿ bytes. */
const HDF5_SIGNATURE = Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a])
/** Largest user block searched for the signature. */
const MAX_USER_BLOCK = 1024 * 1024

/** h5wasm opens any file without an error, so check the signature first. */
async function hasHdf5Signature(abs: string): Promise<boolean> {
  const handle = await open(abs, "r")
  try {
    const head = Buffer.alloc(8)
    for (let offset = 0; offset <= MAX_USER_BLOCK; offset = offset === 0 ? 512 : offset * 2) {
      const { bytesRead } = await handle.read(head, 0, 8, offset)
      if (bytesRead < 8) return false
      if (head.equals(HDF5_SIGNATURE)) return true
    }
    return false
  } finally {
    await handle.close()
  }
}

/** Walk the groups depth-first; true when more than {@link MAX_HDF5_DATASETS} exist. */
function listDatasets(
  module: H5Module,
  group: Group,
  prefix: string,
  out: DatasetEntry[],
): boolean {
  for (const name of group.keys()) {
    const path = `${prefix}/${name}`
    const entity = group.get(name)
    if (entity instanceof module.Dataset) {
      if (out.length >= MAX_HDF5_DATASETS) return true
      out.push({ path, shape: entity.shape ?? [], dtype: dtypeText(entity) })
    } else if (entity instanceof module.Group) {
      if (listDatasets(module, entity, path, out)) return true
    }
  }
  return false
}

function dtypeText(dataset: Dataset): string {
  const dtype = dataset.dtype
  if (typeof dtype === "string") return dtype
  if (Array.isArray(dtype) && dtype.every((member) => Array.isArray(member))) {
    return `compound(${dtype.map((member) => String(member[0])).join(", ")})`
  }
  return JSON.stringify(dtype)
}

/**
 * {@link previewDataset}, or a note naming the dataset when h5wasm cannot read
 * it (e.g. a compression filter it lacks, such as LZF or Blosc), so the
 * dataset list stays usable.
 */
function safePreviewDataset(dataset: Dataset, path: string): DatasetsPreview["preview"] {
  try {
    return previewDataset(dataset, path)
  } catch (error: unknown) {
    // h5wasm throws a plain Error from the HDF5 library.
    const reason = error instanceof Error ? error.message : String(error)
    return { type: "text", text: `Could not read dataset ${path}: ${reason}`, truncated: false }
  }
}

/** h5wasm `metadata.type` values (HDF5 type classes). */
const H5T_INTEGER = 0
const H5T_FLOAT = 1
const H5T_STRING = 3
const H5T_COMPOUND = 6

/** A bounded preview of one dataset. */
function previewDataset(dataset: Dataset, path: string): DatasetsPreview["preview"] {
  const shape = dataset.shape ?? []
  const type = dataset.metadata.type
  const numeric = type === H5T_INTEGER || type === H5T_FLOAT
  const label = path.slice(path.lastIndexOf("/") + 1)
  if (shape.length === 0) {
    return { type: "json", text: JSON.stringify(jsonCell(dataset.value), null, 2) }
  }
  if (shape.length === 1 && numeric) {
    const count = shape[0] ?? 0
    const stride = count > MAX_CHART_POINTS ? Math.ceil(count / MAX_CHART_POINTS) : 1
    const values = Array.from(asArray(dataset.slice([[0, count, stride]])), toNumber)
    const x = values.map((_, i) => i * stride)
    const chart = downsampleChart("index", x, [label], [values.map(finiteOrNull)])
    return { ...chart, truncated: stride > 1 }
  }
  if (shape.length === 1 && type === H5T_COMPOUND) {
    const dtype = dataset.dtype
    const headers = Array.isArray(dtype) ? dtype.map((member) => String(member[0])) : []
    const count = shape[0] ?? 0
    const rows = asArray(dataset.slice([[0, Math.min(count, MAX_TABLE_ROWS)]])).map((row) =>
      Array.isArray(row) ? row.map(cellText) : [cellText(row)],
    )
    return { type: "table", headers, rows, totalRows: count, truncated: count > MAX_TABLE_ROWS }
  }
  if (shape.length <= 2 && (numeric || type === H5T_STRING)) {
    const [rowCount = 0, colCount = 1] = shape
    const shownRows = Math.min(rowCount, MAX_ARRAY_ROWS)
    const shownCols = Math.min(colCount, MAX_ARRAY_COLS)
    const ranges: Array<[number, number]> =
      shape.length === 1
        ? [[0, shownRows]]
        : [
            [0, shownRows],
            [0, shownCols],
          ]
    const flat = asArray(dataset.slice(ranges))
    const rows: string[][] = []
    for (let r = 0; r < shownRows; r++) {
      rows.push(Array.from({ length: shownCols }, (_, c) => cellText(flat[r * shownCols + c])))
    }
    return {
      type: "array",
      dtype: dtypeText(dataset),
      shape,
      columns: Array.from({ length: shownCols }, (_, c) => `c${c}`),
      rows,
      truncated: rowCount > MAX_ARRAY_ROWS || colCount > MAX_ARRAY_COLS,
    }
  }
  return {
    type: "text",
    text: `Dataset of shape (${shape.join(", ")}) and type ${dtypeText(dataset)}; Analysis shows 1-D and 2-D numeric, string and table datasets`,
    truncated: false,
  }
}

function asArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<unknown>)
  }
  return [value]
}

function toNumber(value: unknown): number {
  if (typeof value === "bigint") return Number(value)
  return typeof value === "number" ? value : Number.NaN
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null
}

function cellText(value: unknown): string {
  if (typeof value === "number") return formatCell(value)
  if (typeof value === "bigint") return String(value)
  if (typeof value === "string") return value
  if (typeof value === "boolean") return value ? "True" : "False"
  return JSON.stringify(jsonCell(value))
}

function jsonCell(value: unknown): unknown {
  if (typeof value === "bigint") return String(value)
  if (typeof value === "number" && !Number.isFinite(value)) return String(value)
  if (ArrayBuffer.isView(value)) return asArray(value).slice(0, 200).map(jsonCell)
  if (Array.isArray(value)) return value.slice(0, 200).map(jsonCell)
  return value
}
