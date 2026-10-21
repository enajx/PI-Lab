import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { previewDataFile } from "./discover"

test("CSV chart skips blank x cells and leaves gaps for blank y cells while preserving zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lab-chart-"))
  try {
    const path = join(root, "metrics.csv")
    await writeFile(path, "step,loss\n0,1\n1, \n ,99\n2,0\n3,\n")
    expect(await previewDataFile(path, "metrics.csv")).toMatchObject({
      type: "chart",
      x: [0, 1, 2, 3],
      series: [{ label: "loss", values: [1, null, 0, null] }],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
