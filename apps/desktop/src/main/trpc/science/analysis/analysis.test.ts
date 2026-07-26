// Integration tests for the science.analysis router via createCallerFactory over
// a temp SQLite DB with the real migrations and a real temp git repo (AGENTS.md
// md/engineering/testing-and-build.md). Data files are written into the repo and classified/previewed off real
// bytes — no filesystem mocking.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { TRPCError } from "@trpc/server"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createHarness, type Harness } from "../../testHarness"
import { MAX_CHART_POINTS, MAX_LISTED_FILES, MAX_TABLE_ROWS, MAX_TEXT_BYTES } from "./discover"

let h: Harness

beforeEach(async () => {
  h = await createHarness()
})

afterEach(async () => {
  await h.dispose()
})

/** Write a file at a repo-relative path, creating parent dirs. */
async function writeRepoFile(relPath: string, body: string | Buffer): Promise<void> {
  const abs = join(h.repoDir, relPath)
  await mkdir(join(abs, ".."), { recursive: true })
  await writeFile(abs, body)
}

/** A 1×1 transparent PNG (smallest valid PNG), as raw bytes. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
)

/**
 * Build a little-endian float64 `.npy` (version 1.0) for the given shape from a
 * flat, row-major value list — enough to exercise the real decoder off real
 * bytes, mirroring what `np.save` would write.
 */
function makeNpy(shape: number[], values: number[]): Buffer {
  const shapeText = shape.length === 1 ? `${shape[0]},` : shape.join(", ")
  let header = `{'descr': '<f8', 'fortran_order': False, 'shape': (${shapeText}), }`
  // The header (incl. its trailing newline) is padded so the data starts on a
  // 64-byte boundary, exactly as the NumPy format requires.
  const unpadded = 10 + header.length + 1
  const pad = (64 - (unpadded % 64)) % 64
  header += `${" ".repeat(pad)}\n`

  const prefix = Buffer.alloc(10)
  prefix[0] = 0x93
  prefix.write("NUMPY", 1, "ascii")
  prefix[6] = 1 // major
  prefix[7] = 0 // minor
  prefix.writeUInt16LE(header.length, 8)

  const data = Buffer.alloc(values.length * 8)
  values.forEach((v, i) => {
    data.writeDoubleLE(v, i * 8)
  })

  return Buffer.concat([prefix, Buffer.from(header, "ascii"), data])
}

describe("science.analysis.listFiles", () => {
  test("discovers and classifies data files, grouped by kind", async () => {
    await writeRepoFile("data/metrics.csv", "a,b\n1,2\n")
    await writeRepoFile("data/series.tsv", "x\ty\n1\t2\n")
    await writeRepoFile("config.json", '{"k":1}')
    await writeRepoFile("figs/plot.png", TINY_PNG)
    await writeRepoFile("analysis/explore.py", "print('hi')\n")
    await writeRepoFile("notes.md", "# notes\n")

    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({ projectId: project.id })

    const kindByRel = new Map<string, string>()
    for (const group of listing.groups) {
      for (const file of group.files) kindByRel.set(file.relPath, group.kind)
    }

    expect(kindByRel.get("data/metrics.csv")).toBe("csv")
    expect(kindByRel.get("data/series.tsv")).toBe("tsv")
    expect(kindByRel.get("config.json")).toBe("json")
    expect(kindByRel.get("figs/plot.png")).toBe("image")
    expect(kindByRel.get("notes.md")).toBe("markdown")
    expect(kindByRel.has("analysis/explore.py")).toBe(false)

    // NumPy arrays get their own kinds.
    await writeRepoFile("runs/loss.npy", makeNpy([3], [0.5, 0.3, 0.1]))
    await writeRepoFile("checkpoints/weights.npz", Buffer.from([0x50, 0x4b]))
    const withNpy = await h.caller.science.analysis.listFiles({ projectId: project.id })
    const npyKind = new Map<string, string>()
    for (const group of withNpy.groups) {
      for (const file of group.files) npyKind.set(file.relPath, group.kind)
    }
    expect(npyKind.get("runs/loss.npy")).toBe("npy")
    expect(npyKind.get("checkpoints/weights.npz")).toBe("npz")

    expect(listing.truncated).toBe(false)
    // README.md from the fixture commit is also discovered (markdown).
    expect(listing.total).toBeGreaterThanOrEqual(5)
  })

  test("discovers marimo notebooks but continues to exclude ordinary Python source", async () => {
    await writeRepoFile(
      "reports/live_notebook.py",
      "import marimo\n\napp = marimo.App()\n\nif __name__ == '__main__':\n    app.run()\n",
    )
    await writeRepoFile("reports/script.py", "import marimo\nprint('ordinary script')\n")

    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({ projectId: project.id })
    const kindByRel = new Map<string, string>()
    for (const group of listing.groups) {
      for (const file of group.files) kindByRel.set(file.relPath, group.kind)
    }

    expect(kindByRel.get("reports/live_notebook.py")).toBe("marimo")
    expect(kindByRel.has("reports/script.py")).toBe(false)
  })

  test("recognizes a large marimo notebook from its bounded source prefix", async () => {
    await writeRepoFile(
      "reports/large.py",
      `import marimo\napp = marimo.App()\n${"# generated cell\n".repeat(6_000)}`,
    )
    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({ projectId: project.id })

    expect(
      listing.groups
        .flatMap((group) => group.files)
        .find((file) => file.relPath === "reports/large.py")?.kind,
    ).toBe("marimo")
  })

  test("lists the scientific artifact whitelist and excludes source/unknown files", async () => {
    for (const relPath of [
      "data/table.arrow",
      "data/table.feather",
      "data/experiment.h5",
      "data/climate.nc",
      "data/results.sqlite",
      "data/results.xlsx",
      "reports/summary.html",
      "artifacts/model.pkl",
    ]) {
      await writeRepoFile(relPath, "fixture")
    }
    for (const relPath of [
      "src/analysis.py",
      "scripts/run.sh",
      "scripts/run.ps1",
      "scripts/run.bat",
      "build/native.dylib",
      "mystery.xyz",
    ]) {
      await writeRepoFile(relPath, "not an analysis artifact")
    }
    await mkdir(join(h.repoDir, "runs", "arrays.zarr"), { recursive: true })

    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({ projectId: project.id })
    const kindByRel = new Map(
      listing.groups.flatMap((group) =>
        group.files.map((file) => [file.relPath, file.kind] as const),
      ),
    )

    expect(kindByRel.get("data/experiment.h5")).toBe("dataset")
    expect(kindByRel.get("data/climate.nc")).toBe("dataset")
    expect(kindByRel.get("reports/summary.html")).toBe("report")
    expect(kindByRel.get("artifacts/model.pkl")).toBe("other")
    expect(kindByRel.get("runs/arrays.zarr")).toBe("dataset")
    expect([...kindByRel.keys()].some((path) => /\.(?:py|sh|ps1|bat|dylib|xyz)$/i.test(path))).toBe(
      false,
    )
  })

  test("skips .git and noise directories", async () => {
    await writeRepoFile("real.csv", "a\n1\n")
    await writeRepoFile("node_modules/pkg/data.csv", "junk\n")
    await writeRepoFile("__pycache__/cache.json", "{}")

    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({ projectId: project.id })

    const allRel = listing.groups.flatMap((g) => g.files.map((f) => f.relPath))
    expect(allRel).toContain("real.csv")
    expect(allRel.some((r) => r.includes("node_modules"))).toBe(false)
    expect(allRel.some((r) => r.includes("__pycache__"))).toBe(false)
    expect(allRel.some((r) => r.startsWith(".git/"))).toBe(false)
  })

  test("hides dotfiles (basename starting with a dot)", async () => {
    await writeRepoFile("real.csv", "a\n1\n")
    await writeRepoFile(".env", "SECRET=1\n")
    await writeRepoFile("config/.hidden.json", "{}")
    await writeRepoFile(".secret.csv", "a\n1\n")

    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({ projectId: project.id })

    const allRel = listing.groups.flatMap((g) => g.files.map((f) => f.relPath))
    expect(allRel).toContain("real.csv")
    expect(allRel).not.toContain(".env")
    expect(allRel).not.toContain("config/.hidden.json")
    expect(allRel).not.toContain(".secret.csv")
    // No discovered file's basename starts with a dot.
    expect(allRel.every((r) => !r.slice(r.lastIndexOf("/") + 1).startsWith("."))).toBe(true)
  })

  test("flags truncation when over the cap", async () => {
    // Write one more than the cap of recognized data files.
    const count = MAX_LISTED_FILES + 5
    await Promise.all(
      Array.from({ length: count }, (_, i) => writeRepoFile(`bulk/f${i}.csv`, "a\n1\n")),
    )

    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({ projectId: project.id })

    expect(listing.truncated).toBe(true)
    expect(listing.total).toBe(MAX_LISTED_FILES)
  })

  test("applies the cap after whitelist filtering so source-heavy repos cannot starve results", async () => {
    await Promise.all(
      Array.from({ length: MAX_LISTED_FILES + 5 }, (_, i) =>
        writeRepoFile(`source-${i}.py`, "print('source')\n"),
      ),
    )
    await writeRepoFile("deep/results/metrics.csv", "metric,value\nloss,0.1\n")

    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({ projectId: project.id })
    const paths = listing.groups.flatMap((group) => group.files.map((file) => file.relPath))

    expect(paths).toContain("deep/results/metrics.csv")
    expect(paths.some((path) => path.endsWith(".py"))).toBe(false)
    expect(listing.truncated).toBe(false)
  })

  test("an unknown projectId is a clean NOT_FOUND", async () => {
    await expect(
      h.caller.science.analysis.listFiles({ projectId: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("science.analysis.openInteractive", () => {
  test("HTML reports return an isolated URL without sending document bytes over IPC", async () => {
    await writeRepoFile(
      "reports/interactive.html",
      "<!doctype html><script src='./asset.js'></script>",
    )

    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.openInteractive({
      ownerId: "owner-report",
      leaseId: "lease-report",
      projectId: project.id,
      relPath: "reports/interactive.html",
    })

    expect(preview).toEqual({
      type: "html",
      url: "pi-lab-report://test/report.html",
    })
    expect(h.analysisInteractive.reportStarts).toEqual([
      {
        ownerId: "owner-report",
        generation: 1,
        repoPath: h.repoDir,
        absPath: join(h.repoDir, "reports/interactive.html"),
      },
    ])
  })

  test("marimo starts in the project Python runtime and close is idempotent", async () => {
    await writeRepoFile("reports/live.py", "import marimo\napp = marimo.App()\n")
    const project = await h.caller.projects.open({ path: h.repoDir })

    const opened = await h.caller.science.analysis.openInteractive({
      ownerId: "owner-marimo",
      leaseId: "lease-marimo",
      projectId: project.id,
      relPath: "reports/live.py",
    })
    await h.caller.science.analysis.closeInteractive({
      ownerId: "owner-marimo",
      leaseId: "lease-marimo",
    })
    await h.caller.science.analysis.closeInteractive({
      ownerId: "owner-marimo",
      leaseId: "lease-marimo",
    })

    expect(opened.type).toBe("marimo")
    expect(h.analysisInteractive.marimoStarts).toHaveLength(1)
    expect(h.analysisInteractive.marimoStarts[0]).toMatchObject({
      ownerId: "owner-marimo",
      cwd: h.repoDir,
      absPath: join(h.repoDir, "reports/live.py"),
      portRange: { start: 41_000, end: 41_009 },
    })
    expect(h.analysisInteractive.closes).toEqual([
      { ownerId: "owner-marimo", leaseId: "lease-marimo" },
      { ownerId: "owner-marimo", leaseId: "lease-marimo" },
    ])
  })
})

describe("science.analysis.createTemplate", () => {
  test("creates ready-to-run templates under reports without overwriting an existing file", async () => {
    await writeRepoFile("reports/report.html", "existing")
    const project = await h.caller.projects.open({ path: h.repoDir })

    const html = await h.caller.science.analysis.createTemplate({
      projectId: project.id,
      kind: "html",
    })
    const notebook = await h.caller.science.analysis.createTemplate({
      projectId: project.id,
      kind: "marimo",
    })

    expect(html).toEqual({ relPath: "reports/report-1.html" })
    expect(await readFile(join(h.repoDir, html.relPath), "utf8")).toContain("Interactive report")
    expect(notebook).toEqual({ relPath: "reports/notebook.py" })
    expect(await readFile(join(h.repoDir, notebook.relPath), "utf8")).toContain(
      "app = marimo.App()",
    )
  })
})

describe("science.analysis.preview", () => {
  test("CSV → header + sampled rows + total", async () => {
    await writeRepoFile("d.csv", "name,value\nalpha,1\nbeta,2\ngamma,3\n")

    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "d.csv",
    })

    expect(preview.type).toBe("table")
    if (preview.type !== "table") throw new Error("expected table")
    expect(preview.headers).toEqual(["name", "value"])
    expect(preview.rows).toEqual([
      ["alpha", "1"],
      ["beta", "2"],
      ["gamma", "3"],
    ])
    expect(preview.totalRows).toBe(3)
    expect(preview.truncated).toBe(false)
  })

  test("CSV → quoted fields containing the delimiter parse correctly", async () => {
    await writeRepoFile("q.csv", 'a,b\n"x,y",z\n')

    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "q.csv",
    })
    if (preview.type !== "table") throw new Error("expected table")
    expect(preview.rows).toEqual([["x,y", "z"]])
  })

  test("TSV → splits on tabs", async () => {
    await writeRepoFile("d.tsv", "a\tb\n1\t2\n")
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "d.tsv",
    })
    if (preview.type !== "table") throw new Error("expected table")
    expect(preview.headers).toEqual(["a", "b"])
    expect(preview.rows).toEqual([["1", "2"]])
  })

  test("large CSV → rows sampled to the cap with truncation flagged", async () => {
    const big = ["col", ...Array.from({ length: MAX_TABLE_ROWS + 10 }, (_, i) => String(i))]
    await writeRepoFile("big.csv", `${big.join("\n")}\n`)

    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "big.csv",
    })
    if (preview.type !== "table") throw new Error("expected table")
    expect(preview.rows).toHaveLength(MAX_TABLE_ROWS)
    expect(preview.totalRows).toBe(MAX_TABLE_ROWS + 10)
    expect(preview.truncated).toBe(true)
  })

  test("large text preview returns only the bounded head", async () => {
    await writeRepoFile("run.log", "x".repeat(MAX_TEXT_BYTES + 4_096))

    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "run.log",
    })

    expect(preview.type).toBe("text")
    if (preview.type !== "text") throw new Error("expected text")
    expect(Buffer.byteLength(preview.text)).toBe(MAX_TEXT_BYTES)
    expect(preview.truncated).toBe(true)
  })

  test("JSON → pretty-printed parse", async () => {
    await writeRepoFile("c.json", '{"b":2,"a":1}')

    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "c.json",
    })
    expect(preview.type).toBe("json")
    if (preview.type !== "json") throw new Error("expected json")
    expect(preview.text).toBe('{\n  "b": 2,\n  "a": 1\n}')
  })

  test("invalid JSON → metadata fallback with a note", async () => {
    await writeRepoFile("bad.json", "{not valid")
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "bad.json",
    })
    expect(preview.type).toBe("metadata")
    if (preview.type !== "metadata") throw new Error("expected metadata")
    expect(preview.kind).toBe("json")
    expect(preview.note).toBeTruthy()
  })

  test("image → a data URL", async () => {
    await writeRepoFile("pic.png", TINY_PNG)
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "pic.png",
    })
    expect(preview.type).toBe("image")
    if (preview.type !== "image") throw new Error("expected image")
    expect(preview.dataUrl.startsWith("data:image/png;base64,")).toBe(true)
    expect(preview.dataUrl).toContain(TINY_PNG.toString("base64"))
  })

  test("text/markdown → head", async () => {
    await writeRepoFile("log.txt", "line1\nline2\n")
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "log.txt",
    })
    expect(preview.type).toBe("text")
    if (preview.type !== "text") throw new Error("expected text")
    expect(preview.text).toBe("line1\nline2\n")
    expect(preview.truncated).toBe(false)
  })

  test("unpreviewable kind → metadata", async () => {
    await writeRepoFile("model.parquet", Buffer.from([0x50, 0x41, 0x52, 0x31]))
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "model.parquet",
    })
    expect(preview.type).toBe("metadata")
    if (preview.type !== "metadata") throw new Error("expected metadata")
    expect(preview.kind).toBe("parquet")
  })

  test("numeric metric CSV → a line chart (monotonic step + series)", async () => {
    await writeRepoFile("metrics.csv", "step,loss,reward\n0,1.0,0.1\n1,0.6,0.4\n2,0.3,0.7\n")
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "metrics.csv",
    })
    expect(preview.type).toBe("chart")
    if (preview.type !== "chart") throw new Error("expected chart")
    expect(preview.xLabel).toBe("step")
    expect(preview.x).toEqual([0, 1, 2])
    expect(preview.series.map((s) => s.label)).toEqual(["loss", "reward"])
    expect(preview.series[0]?.values).toEqual([1.0, 0.6, 0.3])
    expect(preview.truncated).toBe(false)
  })

  test("a non-metric CSV (single numeric column) stays a table", async () => {
    await writeRepoFile("people.csv", "name,age\nalice,30\nbob,41\n")
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "people.csv",
    })
    expect(preview.type).toBe("table")
  })

  test("1-D .npy → a single-series line chart over the row index", async () => {
    await writeRepoFile("runs/loss.npy", makeNpy([4], [0.9, 0.6, 0.4, 0.2]))
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "runs/loss.npy",
    })
    expect(preview.type).toBe("chart")
    if (preview.type !== "chart") throw new Error("expected chart")
    expect(preview.xLabel).toBe("index")
    expect(preview.x).toEqual([0, 1, 2, 3])
    expect(preview.series).toHaveLength(1)
    expect(preview.series[0]?.label).toBe("loss")
    expect(preview.series[0]?.values).toEqual([0.9, 0.6, 0.4, 0.2])
  })

  test("a long 1-D .npy is downsampled and flagged truncated", async () => {
    const n = MAX_CHART_POINTS * 3
    await writeRepoFile(
      "big.npy",
      makeNpy(
        [n],
        Array.from({ length: n }, (_, i) => i),
      ),
    )
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "big.npy",
    })
    if (preview.type !== "chart") throw new Error("expected chart")
    expect(preview.truncated).toBe(true)
    expect(preview.x.length).toBeLessThanOrEqual(MAX_CHART_POINTS)
  })

  test("2-D .npy → a bounded array grid", async () => {
    // 2×3 row-major: [[1,2,3],[4,5,6]]
    await writeRepoFile("mat.npy", makeNpy([2, 3], [1, 2, 3, 4, 5, 6]))
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "mat.npy",
    })
    expect(preview.type).toBe("array")
    if (preview.type !== "array") throw new Error("expected array")
    expect(preview.shape).toEqual([2, 3])
    expect(preview.dtype).toBe("<f8")
    expect(preview.columns).toEqual(["c0", "c1", "c2"])
    expect(preview.rows).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ])
    expect(preview.truncated).toBe(false)
  })

  test("a malformed .npy → metadata fallback with a note", async () => {
    await writeRepoFile("bad.npy", Buffer.from("not a numpy array"))
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "bad.npy",
    })
    expect(preview.type).toBe("metadata")
    if (preview.type !== "metadata") throw new Error("expected metadata")
    expect(preview.kind).toBe("npy")
    expect(preview.note).toBeTruthy()
  })

  test(".npz is metadata-only (zips are not unpacked)", async () => {
    await writeRepoFile("arrays.npz", Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "arrays.npz",
    })
    expect(preview.type).toBe("metadata")
    if (preview.type !== "metadata") throw new Error("expected metadata")
    expect(preview.kind).toBe("npz")
  })

  test("pickle is metadata-only and is never opened for preview", async () => {
    const relPath = "model.pkl"
    const absPath = join(h.repoDir, relPath)
    await writeRepoFile(relPath, "unsafe pickle bytes")
    await chmod(absPath, 0)
    const project = await h.caller.projects.open({ path: h.repoDir })

    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath,
    })

    expect(preview.type).toBe("metadata")
    if (preview.type !== "metadata") throw new Error("expected metadata")
    expect(preview.kind).toBe("other")
  })

  test("Zarr directories use the metadata-only preview", async () => {
    const relPath = "arrays.zarr"
    await mkdir(join(h.repoDir, relPath), { recursive: true })
    const project = await h.caller.projects.open({ path: h.repoDir })

    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath,
    })

    expect(preview.type).toBe("metadata")
    if (preview.type !== "metadata") throw new Error("expected metadata")
    expect(preview.kind).toBe("dataset")
  })

  test("path traversal is rejected with FORBIDDEN", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await expect(
      h.caller.science.analysis.preview({ projectId: project.id, relPath: "../secret.txt" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      h.caller.science.analysis.preview({ projectId: project.id, relPath: "/etc/passwd" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  test("a missing file is a clean NOT_FOUND", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await expect(
      h.caller.science.analysis.preview({ projectId: project.id, relPath: "nope.csv" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  test("an unknown projectId is a clean NOT_FOUND", async () => {
    await expect(
      h.caller.science.analysis.preview({ projectId: "missing", relPath: "x.csv" }),
    ).rejects.toBeInstanceOf(TRPCError)
  })
})
