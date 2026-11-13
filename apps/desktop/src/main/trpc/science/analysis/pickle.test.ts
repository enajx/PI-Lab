// The safe unpickler, on real pickles written by Python, NumPy and pandas
// (`__fixtures__/pickle/make_fixtures.py`) and on hand-made malicious and
// malformed bytes. No mocks.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { previewDataFile } from "./discover"
import {
  NdArray,
  PickleFormatError,
  PickleRefusedError,
  type PyBytes,
  PyDict,
  type PySet,
  PyTuple,
  unpickle,
} from "./pickle"

const FIXTURES = join(__dirname, "__fixtures__", "pickle")
const fixture = (name: string): Promise<Buffer> => readFile(join(FIXTURES, name))
const NO_LOAD = { load: false, dataset: null }

describe("unpickle plain data", () => {
  test.each([
    "plain-p0.pkl",
    "plain-p2.pkl",
    "plain-p4.pkl",
    "plain-p5.pkl",
  ])("%s rebuilds every allowlisted value", async (name) => {
    const value = unpickle(await fixture(name))
    if (!(value instanceof PyDict)) throw new Error("expected a dict")
    expect(value.get("none")).toBeNull()
    expect(value.get("flags")).toEqual([true, false])
    const ints = value.get("ints")
    expect(ints).toBeInstanceOf(PyTuple)
    expect((ints as PyTuple).items).toEqual([1, -2, 2n ** 70n])
    const floats = value.get("floats") as number[]
    expect(floats[0]).toBe(0.5)
    expect(Number.isNaN(floats[1])).toBe(true)
    expect(value.get("text")).toBe("héllo")
    expect([...(value.get("raw") as PyBytes).data]).toEqual([0, 1])
    const nested = value.get("nested") as PyDict
    expect((nested.get("set") as PySet).items).toEqual([3])
    expect((nested.get("frozen") as PySet).items).toEqual([4])
    const curve = value.get("curve") as NdArray
    expect(curve).toBeInstanceOf(NdArray)
    expect([curve.at(0), curve.at(1), curve.at(2)]).toEqual([1.5, 2.5, 3.5])
    const grid = value.get("grid") as NdArray
    expect(grid.shape).toEqual([2, 3])
    expect(grid.dtype?.descr).toBe(">i4")
    expect(Array.from({ length: 6 }, (_, i) => grid.at(i))).toEqual([0, 1, 2, 3, 4, 5])
    expect(value.get("scalar")).toBe(0.25)
  })
})

describe("unpickle refuses code", () => {
  test("a class outside the allowlist is refused by name", async () => {
    expect(() => unpickle(new Uint8Array(0))).toThrow(PickleFormatError)
    const bytes = await fixture("refused-class.pkl")
    expect(() => unpickle(bytes)).toThrow(PickleRefusedError)
    expect(() => unpickle(bytes)).toThrow(
      "Stores Python objects of type __main__.RunConfig, which Analysis does not open",
    )
  })

  test("os.system is refused before anything is called", () => {
    const evil = Buffer.from("cos\nsystem\n(S'touch /tmp/pwned'\ntR.", "latin1")
    expect(() => unpickle(evil)).toThrow("os.system")
    const stackGlobal = Buffer.concat([
      Buffer.from([0x80, 0x04]),
      Buffer.from([0x8c, 8]),
      Buffer.from("builtins"),
      Buffer.from([0x8c, 4]),
      Buffer.from("eval"),
      Buffer.from([0x93, 0x2e]),
    ])
    expect(() => unpickle(stackGlobal)).toThrow("builtins.eval")
  })

  test("pandas internals outside the allowlist are refused by name", async () => {
    expect(() => unpickle(new Uint8Array([0x80, 0x04]))).toThrow(PickleFormatError)
    const multiIndex = await fixture("multiindex.pkl")
    expect(() => unpickle(multiIndex)).toThrow("pandas.core.indexes.multi.MultiIndex")
  })
})

describe("unpickle malformed input", () => {
  test.each([
    ["truncated", async () => (await fixture("plain-p4.pkl")).subarray(0, 100)],
    ["unknown opcode", async () => Buffer.from([0x80, 0x04, 0xff])],
    ["stack underflow", async () => Buffer.from([0x80, 0x04, 0x85, 0x2e])],
    ["missing memo", async () => Buffer.from([0x80, 0x04, 0x68, 0x09, 0x2e])],
    ["text", async () => Buffer.from("not a pickle at all")],
  ])("%s throws a format error", async (_, bytes) => {
    const data = await bytes()
    expect(() => unpickle(data)).toThrow(PickleFormatError)
  })
})

describe("pickles in Analysis previews", () => {
  test("the real all-None object .npy says what it stores", async () => {
    const path = join(FIXTURES, "object-all-none.npy")
    const preview = await previewDataFile(path, "object-all-none.npy", NO_LOAD)
    expect(preview).toMatchObject({
      type: "metadata",
      note: "Stores Python objects; all 200 values are None",
    })
  })

  test("an object .npy of numbers and None is a chart with a gap", async () => {
    const path = join(FIXTURES, "object-mixed.npy")
    const preview = await previewDataFile(path, "object-mixed.npy", NO_LOAD)
    if (preview.type !== "chart") throw new Error(`expected a chart, got ${preview.type}`)
    expect(preview.series[0]?.values).toEqual([1, 2.5, null, 4])
  })

  test("a refused class names it on the card", async () => {
    const path = join(FIXTURES, "refused-class.pkl")
    const preview = await previewDataFile(path, "refused-class.pkl", NO_LOAD)
    expect(preview).toMatchObject({
      type: "metadata",
      note: "Stores Python objects of type __main__.RunConfig, which Analysis does not open",
    })
  })

  test("a malformed pickle says it could not be read", async () => {
    const path = join(FIXTURES, "make_fixtures.py")
    const preview = await previewDataFile(path, "notes.pkl", NO_LOAD)
    expect(preview.type).toBe("metadata")
    if (preview.type !== "metadata") throw new Error("expected metadata")
    expect(preview.note).toMatch(/^Could not read the pickle: /)
  })

  test("plain data is shown as JSON", async () => {
    const path = join(FIXTURES, "plain-p4.pkl")
    const preview = await previewDataFile(path, "plain-p4.pkl", NO_LOAD)
    if (preview.type !== "json") throw new Error(`expected json, got ${preview.type}`)
    const parsed = JSON.parse(preview.text)
    expect(parsed.ints).toEqual([1, -2, "1180591620717411303424"])
    expect(parsed.curve).toEqual([1.5, 2.5, 3.5])
    expect(parsed.floats).toEqual([0.5, "NaN"])
  })

  test("a list that holds itself 200 times is shown without walking every path", async () => {
    // l = []; l.extend([l] * 200): 200^20 paths at the JSON depth limit.
    const selfList = Buffer.concat([
      Buffer.from([0x80, 0x04, 0x5d, 0x94, 0x28]),
      Buffer.alloc(400, Buffer.from([0x68, 0x00])),
      Buffer.from([0x65, 0x2e]),
    ])
    const dir = await mkdtemp(join(tmpdir(), "pi-lab-pickle-"))
    const path = join(dir, "self.pkl")
    await writeFile(path, selfList)
    const started = performance.now()
    const preview = await previewDataFile(path, "self.pkl", NO_LOAD)
    expect(preview.type).toBe("json")
    expect(performance.now() - started).toBeLessThan(2000)
    await rm(dir, { recursive: true, force: true })
  })

  test("an all-None list says so", async () => {
    const path = join(FIXTURES, "all-none-list.pkl")
    const preview = await previewDataFile(path, "all-none-list.pkl", NO_LOAD)
    expect(preview).toMatchObject({ note: "Stores Python objects; all 5 values are None" })
  })
})

describe("pandas pickles", () => {
  test("pyarrow-backed strings keep their order and missing values", async () => {
    const path = join(FIXTURES, "p3a-names.pkl")
    const preview = await previewDataFile(path, "p3a-names.pkl", NO_LOAD)
    if (preview.type !== "table") throw new Error(`expected a table, got ${preview.type}`)
    expect(preview.headers).toEqual(["", "names"])
    expect(preview.rows).toEqual([
      ["0", "a"],
      ["1", "None"],
      ["2", "c"],
    ])
  })

  test.each([
    "p1",
    "p2",
    "p3",
    "p3a",
  ])("a %s DataFrame is a table of numeric, string and datetime columns", async (tag) => {
    const path = join(FIXTURES, `${tag}-frame.pkl`)
    const preview = await previewDataFile(path, `${tag}-frame.pkl`, NO_LOAD)
    if (preview.type !== "table") throw new Error(`expected a table, got ${preview.type}`)
    expect(preview.headers).toEqual(["", "step", "loss", "name", "when"])
    expect(preview.rows).toEqual([
      ["0", "0", "0.5", "a", "2024-01-01"],
      ["1", "1", "0.4", "b", "2024-01-02"],
      ["2", "2", "0.3", "c", "2024-01-03"],
      ["3", "3", "0.25", "d", "2024-01-04"],
    ])
    expect(preview.totalRows).toBe(4)
  })

  test.each(["p1", "p2", "p3", "p3a"])("a %s Series is a chart named after it", async (tag) => {
    const path = join(FIXTURES, `${tag}-series.pkl`)
    const preview = await previewDataFile(path, `${tag}-series.pkl`, NO_LOAD)
    if (preview.type !== "chart") throw new Error(`expected a chart, got ${preview.type}`)
    expect(preview.xLabel).toBe("index")
    expect(preview.x).toEqual([0, 1, 2])
    expect(preview.series).toEqual([{ label: "acc", values: [1, 2, 3] }])
  })

  test.each(["p1", "p2", "p3", "p3a"])("a %s Series over dates keeps its values", async (tag) => {
    const value = unpickle(await fixture(`${tag}-series-dates.pkl`))
    const path = join(FIXTURES, `${tag}-series-dates.pkl`)
    const preview = await previewDataFile(path, `${tag}-series-dates.pkl`, NO_LOAD)
    expect(value).toBeTruthy()
    if (preview.type !== "chart") throw new Error(`expected a chart, got ${preview.type}`)
    expect(preview.series).toEqual([{ label: "count", values: [3, 1, 2] }])
  })
})
