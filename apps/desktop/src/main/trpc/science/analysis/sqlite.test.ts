// SQLite previews on a real file: the run database written by Python's sqlite3
// (`__fixtures__/data/make_fixtures.py`) and a fake `.db` written here. No mocks.
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { chartDataFile, hugeFilePartial, previewDataFile, tableDataFile } from "./discover"
import type { DataFilePreview, MetadataPreview, TablePreview } from "./previewShapes"

const FIXTURES = join(__dirname, "__fixtures__", "data")
const RUNS = join(FIXTURES, "runs.db")
const NO_OPS = { filters: [], aggregation: null, sort: [] }

function tableOf(preview: DataFilePreview): TablePreview {
  if (preview.type !== "datasets") throw new Error(`expected datasets, got ${preview.type}`)
  if (preview.preview.type !== "table") {
    throw new Error(`expected a table, got ${preview.preview.type}`)
  }
  return preview.preview
}

describe("SQLite files", () => {
  let dir: string | null = null
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  test("lists the tables and views in file order and previews the first table as a metric log", async () => {
    const preview = await previewDataFile(RUNS, "runs.db", { load: false, dataset: null })
    if (preview.type !== "datasets") throw new Error(`expected datasets, got ${preview.type}`)
    expect(preview.datasets).toEqual([
      { path: "metrics", shape: [50, 3], dtype: "table" },
      { path: "config", shape: [3, 2], dtype: "table" },
      { path: "late_metrics", shape: [25, 3], dtype: "view" },
    ])
    expect(preview.truncated).toBe(false)
    expect(preview.selected).toBe("metrics")

    const table = tableOf(preview)
    expect(table.headers).toEqual(["step", "loss", "acc"])
    expect(table.totalRows).toBe(50)
    expect(table.defaultView).toBe("chart")
    expect(table.defaultSpec).toMatchObject({ x: "step", y: ["loss", "acc"] })
  })

  test("a text table previews as a table", async () => {
    const table = tableOf(
      await previewDataFile(RUNS, "runs.db", { load: false, dataset: "config" }),
    )
    expect(table.defaultView).toBe("table")
    expect(table.rows[0]).toEqual(["model", "model-x"])
    expect(table.columns.map((c) => c.kind)).toEqual(["text", "text"])
  })

  test("the chart builder and table pages read the chosen table or view", async () => {
    const plot = await chartDataFile(RUNS, "runs.db", {
      dataset: "metrics",
      ops: NO_OPS,
      spec: {
        x: "step",
        y: ["loss"],
        splitBy: null,
        chartType: "line",
        aggregate: "none",
        band: "none",
      },
    })
    expect(plot.series[0]?.x.length).toBe(50)
    expect(plot.series[0]?.y[0]).toBe(1)

    const page = await tableDataFile(RUNS, "runs.db", {
      dataset: "late_metrics",
      ops: NO_OPS,
      offset: 0,
      limit: 10,
    })
    expect(page.rows[0]?.[0]).toBe("25")
  })

  test("an unknown table name is an error naming it", async () => {
    await expect(
      tableDataFile(RUNS, "runs.db", { dataset: "nope", ops: NO_OPS, offset: 0, limit: 10 }),
    ).rejects.toThrow(/nope/)
    const preview = await previewDataFile(RUNS, "runs.db", { load: false, dataset: "nope" })
    expect(preview).toMatchObject({ type: "metadata", note: expect.stringMatching(/nope/) })
  })

  test("a file that is not SQLite becomes a metadata card with a note", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-lab-sqlite-"))
    const fake = join(dir, "fake.db")
    await writeFile(fake, "not a database at all, just text that is long enough".repeat(20))
    const preview = await previewDataFile(fake, "fake.db", { load: false, dataset: null })
    expect(preview.type).toBe("metadata")
    expect((preview as MetadataPreview).note).toMatch(/^Could not read the SQLite file: /)
  })

  test("a database with no tables says so", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-lab-sqlite-"))
    const empty = join(dir, "empty.sqlite")
    await writeFile(empty, "")
    const preview = await previewDataFile(empty, "empty.sqlite", { load: false, dataset: null })
    expect(preview).toMatchObject({ type: "metadata", note: "This SQLite file has no tables" })
  })

  test("a huge file shows its table list and first table", async () => {
    const meta = (note?: string): MetadataPreview => ({
      type: "metadata",
      kind: "dataset",
      size: 0,
      mtime: 0,
      note,
    })
    const partial = await hugeFilePartial(RUNS, "runs.db", "metrics", meta)
    expect(tableOf(partial as DataFilePreview).totalRows).toBe(50)
  })
})
