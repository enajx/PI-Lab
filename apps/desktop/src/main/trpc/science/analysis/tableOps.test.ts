// Table operations (filter, aggregate, sort), paging and CSV export on the
// synthetic long-format fixture (`__fixtures__/data/long.csv`, 108 rows:
// question 1..6 × option_order 0..2 × repetition 0..1 × option a..c, with
// probability = 0.1 + 0.05·position + 0.01·question). No mocks.
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { chartDataFile, csvOfDataFile, tableDataFile } from "./discover"
import type { TableOps } from "./previewShapes"

const LONG = join(__dirname, "__fixtures__", "data", "long.csv")
const NONE: TableOps = { filters: [], aggregation: null, sort: [] }

/** Every row of the result for `ops`, as table text. */
async function rowsOf(ops: TableOps) {
  return tableDataFile(LONG, "long.csv", { dataset: null, ops, offset: 0, limit: 500 })
}

describe("table operations", () => {
  test("no operations pages through the rows read", async () => {
    const page = await tableDataFile(LONG, "long.csv", {
      dataset: null,
      ops: NONE,
      offset: 100,
      limit: 50,
    })
    expect(page.totalRows).toBe(108)
    expect(page.offset).toBe(100)
    expect(page.rows).toHaveLength(8)
    expect(page.headers[0]).toBe("model")
  })

  test("filters keep the rows that match every condition", async () => {
    const page = await rowsOf({
      ...NONE,
      filters: [
        { column: "option", op: "eq", value: "a", values: [] },
        { column: "question", op: "le", value: "2", values: [] },
      ],
    })
    expect(page.totalRows).toBe(12)
    const contains = await rowsOf({
      ...NONE,
      filters: [{ column: "model", op: "contains", value: "MODEL", values: [] }],
    })
    expect(contains.totalRows).toBe(108)
    const oneOf = await rowsOf({
      ...NONE,
      filters: [{ column: "option", op: "in", value: "", values: ["a", "c"] }],
    })
    expect(oneOf.totalRows).toBe(72)
    const gt = await rowsOf({
      ...NONE,
      filters: [{ column: "probability", op: "gt", value: "0.25", values: [] }],
    })
    expect(gt.totalRows).toBe(6)
  })

  test("a filter with no value yet does nothing", async () => {
    for (const op of ["eq", "lt", "contains"] as const) {
      const page = await rowsOf({
        ...NONE,
        filters: [{ column: "question", op, value: " ", values: [] }],
      })
      expect(page.totalRows).toBe(108)
    }
    const oneOf = await rowsOf({
      ...NONE,
      filters: [{ column: "option", op: "in", value: "", values: [] }],
    })
    expect(oneOf.totalRows).toBe(108)
  })

  test("is one of compares numbers as numbers, and True/False ignore case", async () => {
    const numbers = await rowsOf({
      ...NONE,
      filters: [{ column: "question", op: "in", value: "", values: ["1.0", "2"] }],
    })
    expect(numbers.totalRows).toBe(36)
    const gold = await rowsOf({
      ...NONE,
      filters: [{ column: "is_gold", op: "eq", value: "true", values: [] }],
    })
    expect(gold.totalRows).toBe(36)
  })

  test("sort orders rows, several keys in turn", async () => {
    const page = await rowsOf({
      ...NONE,
      sort: [
        { column: "probability", descending: true },
        { column: "option_order", descending: false },
      ],
    })
    const prob = page.headers.indexOf("probability")
    const order = page.headers.indexOf("option_order")
    expect(page.rows[0]?.[prob]).toBe("0.26")
    expect(page.rows.slice(0, 6).map((row) => row[order])).toEqual(["0", "0", "1", "1", "2", "2"])
  })

  test("group by and aggregate", async () => {
    const page = await rowsOf({
      ...NONE,
      aggregation: {
        kind: "groupBy",
        by: ["question"],
        values: [
          { column: "probability", fn: "mean" },
          { column: "probability", fn: "count" },
          { column: "length", fn: "max" },
        ],
      },
    })
    expect(page.headers).toEqual([
      "question",
      "probability (mean)",
      "probability (count)",
      "length (max)",
    ])
    expect(page.totalRows).toBe(6)
    expect(page.rows[0]?.slice(0, 3)).toEqual(["1", "0.16", "18"])
  })

  test("group by with no value columns counts the rows per group", async () => {
    const page = await rowsOf({
      ...NONE,
      aggregation: { kind: "groupBy", by: ["question"], values: [] },
    })
    expect(page.headers).toEqual(["question", "count"])
    expect(page.rows[0]).toEqual(["1", "18"])
    expect(page.defaultSpec).not.toBeNull()
  })

  test("pivot table", async () => {
    const page = await rowsOf({
      ...NONE,
      aggregation: {
        kind: "pivot",
        index: "question",
        columns: "option",
        values: "probability",
        fn: "mean",
      },
    })
    expect(page.headers).toEqual(["question", "a", "b", "c"])
    expect(page.rows[0]).toEqual(["1", "0.11", "0.16", "0.21"])
  })

  test("describe gives statistics per column", async () => {
    const page = await rowsOf({ ...NONE, aggregation: { kind: "describe" } })
    expect(page.headers[0]).toBe("statistic")
    const stat = page.rows.map((row) => row[0])
    expect(stat).toEqual(
      expect.arrayContaining([
        "count",
        "mean",
        "std",
        "min",
        "25%",
        "50%",
        "75%",
        "max",
        "unique",
        "top",
        "freq",
      ]),
    )
    const mean = page.rows.find((row) => row[0] === "mean")
    const prob = page.headers.indexOf("probability")
    expect(Number(mean?.[prob])).toBeCloseTo(0.185)
  })

  test("value counts", async () => {
    const page = await rowsOf({
      ...NONE,
      aggregation: { kind: "valueCounts", columns: ["option"] },
    })
    expect(page.headers).toEqual(["option", "count"])
    expect(page.rows.map((row) => row[1])).toEqual(["36", "36", "36"])
  })

  test("filters run before the aggregation", async () => {
    const page = await rowsOf({
      filters: [{ column: "option", op: "eq", value: "c", values: [] }],
      aggregation: {
        kind: "groupBy",
        by: ["question"],
        values: [{ column: "probability", fn: "mean" }],
      },
      sort: [{ column: "question", descending: true }],
    })
    expect(page.rows[0]).toEqual(["6", "0.26"])
  })

  test("the chart builder plots the result", async () => {
    const plot = await chartDataFile(LONG, "long.csv", {
      dataset: null,
      ops: {
        ...NONE,
        aggregation: {
          kind: "groupBy",
          by: ["question"],
          values: [{ column: "probability", fn: "mean" }],
        },
      },
      spec: {
        x: "question",
        y: ["probability (mean)"],
        splitBy: null,
        chartType: "line",
        aggregate: "none",
        band: "none",
      },
    })
    expect(plot.series[0]?.x).toEqual([1, 2, 3, 4, 5, 6])
  })

  test("an unknown column and a mean of text are errors naming them", async () => {
    await expect(
      rowsOf({ ...NONE, filters: [{ column: "nope", op: "eq", value: "1", values: [] }] }),
    ).rejects.toThrow(/nope/)
    await expect(
      rowsOf({
        ...NONE,
        aggregation: {
          kind: "groupBy",
          by: ["question"],
          values: [{ column: "option", fn: "mean" }],
        },
      }),
    ).rejects.toThrow(/option/)
  })

  test("the result exports as CSV", async () => {
    const { csv } = await csvOfDataFile(LONG, "long.csv", {
      dataset: null,
      ops: { ...NONE, aggregation: { kind: "valueCounts", columns: ["option"] } },
      columns: null,
    })
    expect(csv).toBe("option,count\na,36\nb,36\nc,36\n")
    const { csv: shown } = await csvOfDataFile(LONG, "long.csv", {
      dataset: null,
      ops: { ...NONE, aggregation: { kind: "valueCounts", columns: ["option"] } },
      columns: ["count", "option"],
    })
    expect(shown.split("\n")[1]).toBe("36,a")
  })
})
