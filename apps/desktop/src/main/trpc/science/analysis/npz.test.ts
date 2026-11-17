// NumPy zip (.npz) previews on real files written by NumPy
// (`__fixtures__/data/make_fixtures.py`: np.savez and np.savez_compressed)
// and a fake `.npz` written here. No mocks.
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { previewDataFile } from "./discover"
import type { DataFilePreview, DatasetsPreview } from "./previewShapes"

const FIXTURES = join(__dirname, "__fixtures__", "data")

function datasetsOf(preview: DataFilePreview): DatasetsPreview {
  if (preview.type !== "datasets") throw new Error(`expected datasets, got ${preview.type}`)
  return preview
}

describe("NumPy zip files", () => {
  let dir: string | null = null
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  for (const name of ["arrays.npz", "arrays-compressed.npz"]) {
    test(`${name}: lists the arrays and previews loss as a chart`, async () => {
      const preview = datasetsOf(
        await previewDataFile(join(FIXTURES, name), name, { load: false, dataset: null }),
      )
      expect(preview.datasets).toEqual([
        { path: "loss", shape: [100], dtype: "<f8" },
        { path: "grid", shape: [3, 4], dtype: "<i4" },
      ])
      expect(preview.truncated).toBe(false)
      expect(preview.selected).toBe("loss")
      const chart = preview.preview
      if (chart.type !== "chart") throw new Error(`expected a chart, got ${chart.type}`)
      expect(chart.series[0]?.label).toBe("loss")
      expect(chart.x).toHaveLength(100)
      expect(chart.series[0]?.values[0]).toBe(1)
      expect(chart.series[0]?.values[3]).toBe(0.25)
    })

    test(`${name}: previews grid as a grid`, async () => {
      const preview = datasetsOf(
        await previewDataFile(join(FIXTURES, name), name, { load: false, dataset: "grid" }),
      )
      expect(preview.selected).toBe("grid")
      const grid = preview.preview
      if (grid.type !== "array") throw new Error(`expected an array, got ${grid.type}`)
      expect(grid.shape).toEqual([3, 4])
      expect(grid.dtype).toBe("<i4")
      expect(grid.rows).toEqual([
        ["0", "1", "2", "3"],
        ["4", "5", "6", "7"],
        ["8", "9", "10", "11"],
      ])
    })

    test(`${name}: an unknown array name is a note naming it`, async () => {
      const preview = await previewDataFile(join(FIXTURES, name), name, {
        load: false,
        dataset: "nope",
      })
      if (preview.type !== "metadata") throw new Error(`expected metadata, got ${preview.type}`)
      expect(preview.note).toMatch(/nope/)
    })
  }

  test("a .npz that is not a zip says so", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-lab-npz-"))
    const path = join(dir, "fake.npz")
    await writeFile(path, "not a zip file at all")
    const preview = await previewDataFile(path, "fake.npz", { load: false, dataset: null })
    if (preview.type !== "metadata") throw new Error(`expected metadata, got ${preview.type}`)
    expect(preview.kind).toBe("npz")
    expect(preview.note).toMatch(/not a zip/i)
  })
})
