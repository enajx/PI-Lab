import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { chartDataFile, previewDataFile } from "./discover"

test("CSV chart skips blank x cells and leaves gaps for blank y cells while preserving zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lab-chart-"))
  try {
    const path = join(root, "metrics.csv")
    await writeFile(path, "step,loss\n0,1.5\n1, \n ,99\n2,0\n3,\n")
    const preview = await previewDataFile(path, "metrics.csv", { load: false, dataset: null })
    if (preview.type !== "table" || !preview.defaultSpec) throw new Error("expected a table")
    expect(preview.defaultView).toBe("chart")
    expect(
      await chartDataFile(path, "metrics.csv", { dataset: null, spec: preview.defaultSpec }),
    ).toMatchObject({ series: [{ label: "loss", x: [0, 1, 2, 3], y: [1.5, null, 0, null] }] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
