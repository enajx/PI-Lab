// Table reading and the chart builder, on real files: the long-format fixture
// written by pandas, pyarrow and h5py (`__fixtures__/data/make_fixtures.py`)
// and CSVs written here. No mocks.
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { chartDataFile, previewDataFile } from "./discover"
import type { ChartSpec, DataFilePreview, TablePreview } from "./previewShapes"

const FIXTURES = join(__dirname, "__fixtures__", "data")
const NO_LOAD = { load: false, dataset: null }

/** The table inside a preview (HDF5 wraps it in a dataset list). */
function tableOf(preview: DataFilePreview): TablePreview {
  const inner = preview.type === "datasets" ? preview.preview : preview
  if (inner.type !== "table") throw new Error(`expected a table, got ${inner.type}`)
  return inner
}

const LONG_FILES: Array<{ name: string; dataset: string | null }> = [
  { name: "long.csv", dataset: null },
  { name: "long.parquet", dataset: null },
  { name: "long-frame.pkl", dataset: null },
  { name: "long.h5", dataset: "/table" },
]

describe("long-format tables", () => {
  for (const { name, dataset } of LONG_FILES) {
    test(`${name} opens as a table, with a mean-per-question default chart`, async () => {
      const preview = await previewDataFile(join(FIXTURES, name), name, { load: false, dataset })
      const table = tableOf(preview)
      expect(table.defaultView).toBe("table")
      expect(table.totalRows).toBe(108)
      const roles = Object.fromEntries(table.columns.map((c) => [c.name, c.role]))
      expect(roles.question).toBe("factor")
      expect(roles.option_order).toBe("factor")
      expect(roles.repetition).toBe("factor")
      expect(roles.probability).toBe("measure")
      expect(table.defaultSpec).toMatchObject({
        x: "question",
        y: ["probability"],
        aggregate: "mean",
        splitBy: null,
        chartType: "line",
        band: "none",
      })
    })
  }

  test("text and True/False columns are factors", async () => {
    const table = tableOf(await previewDataFile(join(FIXTURES, "long.csv"), "long.csv", NO_LOAD))
    const roles = Object.fromEntries(table.columns.map((c) => [c.name, c.role]))
    expect(roles.model).toBe("factor")
    expect(roles.option).toBe("factor")
    expect(roles.is_gold).toBe("factor")
  })
})

describe("chart builder", () => {
  const spec: ChartSpec = {
    x: "question",
    y: ["probability"],
    splitBy: null,
    chartType: "line",
    aggregate: "mean",
    band: "minmax",
  }

  for (const { name, dataset } of LONG_FILES) {
    test(`${name}: mean probability per question with a min–max band`, async () => {
      const plot = await chartDataFile(join(FIXTURES, name), name, { dataset, spec })
      expect(plot.series).toHaveLength(1)
      const series = plot.series[0]
      expect(series?.x).toEqual([1, 2, 3, 4, 5, 6])
      // Per question: positions 0..2 give 0.1, 0.15, 0.2 plus 0.01·question.
      expect(series?.y.map((v) => Number(v?.toFixed(4)))).toEqual([
        0.16, 0.17, 0.18, 0.19, 0.2, 0.21,
      ])
      expect(series?.lo?.[0]).toBeCloseTo(0.11)
      expect(series?.hi?.[0]).toBeCloseTo(0.21)
      expect(plot.rowsUsed).toBe(108)
      expect(plot.partial).toBe(false)
    })
  }

  test("split by a column draws one line per value", async () => {
    const plot = await chartDataFile(join(FIXTURES, "long.csv"), "long.csv", {
      dataset: null,
      spec: { ...spec, splitBy: "option", band: "none" },
    })
    expect(plot.series.map((s) => s.label)).toEqual(["option=a", "option=b", "option=c"])
    expect(plot.series[0]?.y[0]).toBeCloseTo(0.11)
  })

  test("a True/False column charts as a 0/1 mean; count and sum aggregate", async () => {
    const file = join(FIXTURES, "long.csv")
    const gold = await chartDataFile(file, "long.csv", {
      dataset: null,
      spec: { ...spec, y: ["is_gold"], band: "none" },
    })
    expect(gold.series[0]?.y.map((v) => Number(v?.toFixed(4)))).toEqual(Array(6).fill(0.3333))
    const count = await chartDataFile(file, "long.csv", {
      dataset: null,
      spec: { ...spec, aggregate: "count", band: "none" },
    })
    expect(count.series[0]?.y).toEqual(Array(6).fill(18))
  })

  test("a text x column is categorical", async () => {
    const plot = await chartDataFile(join(FIXTURES, "long.csv"), "long.csv", {
      dataset: null,
      spec: { ...spec, x: "option", chartType: "bar", band: "none" },
    })
    expect(plot.xCategories).toEqual(["a", "b", "c"])
    expect(plot.series[0]?.x).toEqual([0, 1, 2])
  })

  test("std and 95% CI bands sit around the mean", async () => {
    const file = join(FIXTURES, "long.csv")
    const std = await chartDataFile(file, "long.csv", {
      dataset: null,
      spec: { ...spec, band: "std" },
    })
    const ci = await chartDataFile(file, "long.csv", {
      dataset: null,
      spec: { ...spec, band: "ci95" },
    })
    const mean = std.series[0]?.y[0] ?? 0
    const sd = (std.series[0]?.hi?.[0] ?? 0) - mean
    expect(sd).toBeGreaterThan(0)
    expect((ci.series[0]?.hi?.[0] ?? 0) - mean).toBeCloseTo((1.96 * sd) / Math.sqrt(18))
  })

  test("an unknown column is an error naming it", async () => {
    await expect(
      chartDataFile(join(FIXTURES, "long.csv"), "long.csv", {
        dataset: null,
        spec: { ...spec, y: ["nope"] },
      }),
    ).rejects.toThrow(/nope/)
  })
})

describe("metric logs and row limit", () => {
  let dir = ""
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  test("a metric log opens as a chart of its measures, not its factor columns", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-lab-tables-"))
    const path = join(dir, "metrics.csv")
    const lines = ["step,seed,loss,acc"]
    for (let step = 0; step < 50; step++) lines.push(`${step},3,${1 / (step + 1)},${step / 50}`)
    await writeFile(path, `${lines.join("\n")}\n`)
    const table = tableOf(await previewDataFile(path, "metrics.csv", NO_LOAD))
    expect(table.defaultView).toBe("chart")
    expect(table.defaultSpec).toMatchObject({ x: "step", y: ["loss", "acc"], aggregate: "none" })
  })

  /** Write `body` to a temp CSV and return its table preview. */
  async function csvTable(body: string): Promise<TablePreview> {
    dir = await mkdtemp(join(tmpdir(), "pi-lab-tables-"))
    const path = join(dir, "log.csv")
    await writeFile(path, body)
    return tableOf(await previewDataFile(path, "log.csv", NO_LOAD))
  }

  test("a step column after an epoch column is still the step", async () => {
    const lines = ["epoch,step,loss"]
    for (let step = 0; step < 40; step++)
      lines.push(`${Math.floor(step / 10)},${step},${1 / (step + 1)}`)
    const table = await csvTable(`${lines.join("\n")}\n`)
    expect(table.defaultView).toBe("chart")
    expect(table.defaultSpec).toMatchObject({ x: "step", y: ["loss"], aggregate: "none" })
  })

  test("a metric log does not plot few-valued integer columns", async () => {
    const lines = ["step,epoch,lr_phase,loss"]
    for (let step = 0; step < 40; step++) {
      lines.push(`${step},${Math.floor(step / 10)},${step < 20 ? 0 : 1},${1 / (step + 1)}`)
    }
    const table = await csvTable(`${lines.join("\n")}\n`)
    expect(table.defaultSpec?.y).toEqual(["loss"])
  })

  test("nan and inf cells are blanks in a numeric column", async () => {
    const table = await csvTable("step,loss\n0,nan\n1,0.5\n2,inf\n3,-inf\n4,NaN\n")
    expect(table.columns.find((c) => c.name === "loss")).toMatchObject({
      kind: "number",
      role: "measure",
    })
  })

  test("a UTF-8 byte order mark is not part of the first header", async () => {
    const table = await csvTable("\uFEFFstep,loss\n0,1.5\n1,0.5\n")
    expect(table.headers[0]).toBe("step")
  })

  test("charts read at most 100,000 rows and say so", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-lab-tables-"))
    const path = join(dir, "long-log.csv")
    const lines = ["step,loss"]
    for (let step = 0; step < 100_050; step++) lines.push(`${step},${step % 7}`)
    await writeFile(path, `${lines.join("\n")}\n`)
    const plot = await chartDataFile(path, "long-log.csv", {
      dataset: null,
      spec: {
        x: "step",
        y: ["loss"],
        splitBy: null,
        chartType: "line",
        aggregate: "none",
        band: "none",
      },
    })
    expect(plot.rowsUsed).toBe(100_000)
    expect(plot.partial).toBe(true)
  })
})
