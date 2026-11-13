// HDF5 and Parquet previews and the Large file gate, on real files written by
// h5py and pyarrow (`__fixtures__/data/make_fixtures.py`). No mocks.
import { copyFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { previewDataFile } from "./discover"
import { LARGE_FILE_BYTES } from "./previewShapes"

const FIXTURES = join(__dirname, "__fixtures__", "data")
const NO_LOAD = { load: false, dataset: null }

describe("HDF5", () => {
  const path = join(FIXTURES, "runs.h5")

  test("lists every dataset and previews the first as a chart", async () => {
    const preview = await previewDataFile(path, "runs.h5", NO_LOAD)
    if (preview.type !== "datasets") throw new Error(`expected datasets, got ${preview.type}`)
    expect(preview.datasets.map((d) => d.path)).toEqual([
      "/eval/cube",
      "/eval/names",
      "/eval/table",
      "/grid",
      "/loss",
      "/scalar",
    ])
    expect(preview.selected).toBe("/eval/cube")
    expect(preview.preview).toMatchObject({
      type: "text",
      text: expect.stringMatching(/^Dataset of shape \(2, 3, 4\)/),
    })
  })

  test("a 1-D dataset is a chart, a 2-D one a grid, a compound one a table", async () => {
    const loss = await previewDataFile(path, "runs.h5", { load: false, dataset: "/loss" })
    if (loss.type !== "datasets" || loss.preview.type !== "chart") throw new Error("expected chart")
    expect(loss.preview.x).toHaveLength(100)
    expect(loss.preview.series[0]?.values.slice(0, 2)).toEqual([1, 0.5])
    expect(loss.preview.series[0]?.label).toBe("loss")

    const grid = await previewDataFile(path, "runs.h5", { load: false, dataset: "/grid" })
    if (grid.type !== "datasets" || grid.preview.type !== "array") throw new Error("expected grid")
    expect(grid.preview.rows).toEqual([
      ["0", "1", "2", "3"],
      ["4", "5", "6", "7"],
      ["8", "9", "10", "11"],
    ])

    const table = await previewDataFile(path, "runs.h5", { load: false, dataset: "/eval/table" })
    if (table.type !== "datasets" || table.preview.type !== "table")
      throw new Error("expected table")
    expect(table.preview.headers).toEqual(["step", "acc"])
    expect(table.preview.rows).toEqual([
      ["0", "0.5"],
      ["10", "0.75"],
      ["20", "0.875"],
    ])

    const names = await previewDataFile(path, "runs.h5", { load: false, dataset: "/eval/names" })
    if (names.type !== "datasets" || names.preview.type !== "array")
      throw new Error("expected grid")
    expect(names.preview.rows).toEqual([["alpha"], ["beta"]])
  })

  test("a file that is not HDF5 says so", async () => {
    const preview = await previewDataFile(join(FIXTURES, "make_fixtures.py"), "x.h5", NO_LOAD)
    expect(preview.type).toBe("metadata")
    if (preview.type !== "metadata") throw new Error("expected metadata")
    expect(preview.note).toMatch(/^Could not read the HDF5 file/)
  })
})

describe("Parquet", () => {
  test.each([
    "snappy",
    "gzip",
    "zstd",
    "brotli",
    "none",
  ])("a %s file is a table of its first rows", async (codec) => {
    const name = `frame-${codec}.parquet`
    const preview = await previewDataFile(join(FIXTURES, name), name, NO_LOAD)
    if (preview.type !== "table") throw new Error(`expected a table, got ${preview.type}`)
    expect(preview.headers).toEqual(["step", "loss", "name", "when"])
    expect(preview.rows).toEqual([
      ["0", "0.5", "a", "2024-01-01"],
      ["1", "0.4", "b", "2024-01-02"],
      ["2", "0.3", "", "2024-01-03"],
      ["3", "0.25", "d", "2024-01-04"],
    ])
    expect(preview.totalRows).toBe(4)
  })

  test("a file that is not Parquet says so", async () => {
    const preview = await previewDataFile(join(FIXTURES, "make_fixtures.py"), "x.parquet", NO_LOAD)
    expect(preview.type).toBe("metadata")
    if (preview.type !== "metadata") throw new Error("expected metadata")
    expect(preview.note).toMatch(/^Could not read the Parquet file/)
  })
})

/** The pickle size limit (a number: pickles always have one). */
function pickleLimit(): number {
  const limit = LARGE_FILE_BYTES.pickle
  if (limit === null) throw new Error("pickles have a size limit")
  return limit
}

describe("Large file gate", () => {
  let dir: string
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("a pickle above the limit is read only when load is asked", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-lab-large-"))
    const limit = pickleLimit()
    const path = join(dir, "big.pkl")
    // One bytes object (BINBYTES8) padded to just past the limit.
    const head = Buffer.alloc(11)
    head.set([0x80, 4, 0x8e])
    head.writeBigUInt64LE(BigInt(limit - 11), 3)
    await writeFile(path, Buffer.concat([head, Buffer.alloc(limit - 11), Buffer.from([0x2e])]))
    const gated = await previewDataFile(path, "big.pkl", NO_LOAD)
    expect(gated).toEqual({ type: "large", kind: "other", size: limit + 1 })
    const loaded = await previewDataFile(path, "big.pkl", { load: true, dataset: null })
    expect(loaded.type).toBe("json")
  })

  test("HDF5 and Parquet have no limit: they read only what is shown", () => {
    expect(LARGE_FILE_BYTES.hdf5).toBeNull()
    expect(LARGE_FILE_BYTES.parquet).toBeNull()
  })

  test("an object .npy above the pickle limit asks too; a numeric one never does", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-lab-large-"))
    const objects = join(dir, "objects.npy")
    await copyFile(join(__dirname, "__fixtures__", "pickle", "object-all-none.npy"), objects)
    await truncate(objects, pickleLimit() + 1)
    expect(await previewDataFile(objects, "objects.npy", NO_LOAD)).toMatchObject({ type: "large" })
    const numbers = join(dir, "numbers.npy")
    const header = "{'descr': '<f8', 'fortran_order': False, 'shape': (5000000,), }"
    const padded = `${header}${" ".repeat(118 - header.length)}\n`
    const prefix = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0, padded.length, 0])
    await writeFile(numbers, Buffer.concat([prefix, Buffer.from(padded)]))
    await truncate(numbers, prefix.length + padded.length + 5_000_000 * 8)
    expect(await previewDataFile(numbers, "numbers.npy", NO_LOAD)).toMatchObject({ type: "chart" })
  })

  test("at the limit the file is read", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-lab-large-"))
    const path = join(dir, "small.pkl")
    await copyFile(join(__dirname, "__fixtures__", "pickle", "p2-series.pkl"), path)
    const preview = await previewDataFile(path, "small.pkl", NO_LOAD)
    expect(preview.type).toBe("chart")
  })
})
