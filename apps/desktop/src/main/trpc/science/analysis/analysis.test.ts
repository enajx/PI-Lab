// Integration tests for the science.analysis router via createCallerFactory over
// a temp SQLite DB with the real migrations and a real temp git repo (AGENTS.md
// Data files are written into the repo and classified/previewed off real
// bytes — no filesystem mocking.
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { TRPCError } from "@trpc/server"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createHarness, type Harness } from "../../testHarness"
import {
  MAX_CHART_POINTS,
  MAX_LISTED_FILES,
  MAX_NPY_BYTES,
  MAX_TABLE_ROWS,
  MAX_TEXT_BYTES,
} from "./discover"

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

/** Build a version 1 NumPy file with chosen raw bytes and header fields. */
function makeRawNpy(shape: string, descr: string, fortran: boolean, data: Buffer): Buffer {
  let header = `{'descr': '${descr}', 'fortran_order': ${fortran ? "True" : "False"}, 'shape': (${shape}), }`
  const pad = (64 - ((10 + header.length + 1) % 64)) % 64
  header += `${" ".repeat(pad)}\n`
  const prefix = Buffer.alloc(10)
  prefix[0] = 0x93
  prefix.write("NUMPY", 1, "ascii")
  prefix[6] = 1
  prefix.writeUInt16LE(header.length, 8)
  return Buffer.concat([prefix, Buffer.from(header, "ascii"), data])
}

/** Each listed file as relPath → [experiment, run]. */
function experimentRuns(listing: {
  groups: Array<{
    files: Array<{ relPath: string; experiment: string | null; run: string | null }>
  }>
}): Record<string, [string | null, string | null]> {
  return Object.fromEntries(
    listing.groups.flatMap((group) =>
      group.files.map((file) => [file.relPath, [file.experiment, file.run]] as const),
    ),
  )
}

describe("experiments folder structure", () => {
  const structurePath = () => join(h.dataDir, "experiments-structure.yaml")

  async function writeGecko(): Promise<void> {
    await writeRepoFile("results/gecko/fl-shape_s0/run.db", "")
    await writeRepoFile("results/gecko/fl-shape_s1/run.db", "")
    await writeRepoFile("results/gecko/fl-shape_s1/metrics.csv", "a\n1\n")
    await writeRepoFile("results/exp-a/plot.png", TINY_PNG)
    await writeRepoFile("results/summary.json", "{}")
  }

  async function list(projectId: string) {
    return h.caller.science.analysis.listFiles({ projectId, defaultResultsFolder: "results" })
  }

  test("auto-detect (the default): folders that hold data files are runs, grouped by their parent folder", async () => {
    await writeGecko()
    const project = await h.caller.projects.open({ path: h.repoDir })
    expect(experimentRuns(await list(project.id))).toEqual({
      "results/gecko/fl-shape_s0/run.db": ["gecko", "fl-shape_s0"],
      "results/gecko/fl-shape_s1/run.db": ["gecko", "fl-shape_s1"],
      "results/gecko/fl-shape_s1/metrics.csv": ["gecko", "fl-shape_s1"],
      "results/exp-a/plot.png": [null, "exp-a"],
      "results/summary.json": [null, null],
    })
    expect(await h.caller.science.analysis.getStructure({ projectId: project.id })).toEqual({
      filePath: structurePath(),
      defaultValue: "auto",
      projectValue: null,
    })
  })

  test("each preset groups the listing and is stored per project in the YAML file", async () => {
    await writeGecko()
    const project = await h.caller.projects.open({ path: h.repoDir })
    const set = (value: string) =>
      h.caller.science.analysis.setStructure({ projectId: project.id, value })

    await set("one-folder-per-experiment")
    expect(experimentRuns(await list(project.id))).toMatchObject({
      "results/gecko/fl-shape_s0/run.db": ["gecko", null],
      "results/exp-a/plot.png": ["exp-a", null],
      "results/summary.json": [null, null],
    })

    await set("experiment-run")
    expect(experimentRuns(await list(project.id))).toMatchObject({
      "results/gecko/fl-shape_s0/run.db": ["gecko", "fl-shape_s0"],
      "results/exp-a/plot.png": ["exp-a", null],
    })

    const saved = await set("flat")
    expect(saved).toEqual({ filePath: structurePath(), defaultValue: "auto", projectValue: "flat" })
    expect(Object.values(experimentRuns(await list(project.id)))).toEqual(
      Array(5).fill([null, null]),
    )
    const text = await readFile(structurePath(), "utf8")
    expect(text).toContain("default: auto")
    expect(text).toContain(`${project.repoPath}: flat`)

    // Removing the project's entry uses the default again.
    await h.caller.science.analysis.setStructure({ projectId: project.id, value: null })
    expect(
      (await h.caller.science.analysis.getStructure({ projectId: project.id })).projectValue,
    ).toBeNull()
    expect(experimentRuns(await list(project.id))["results/exp-a/plot.png"]).toEqual([
      null,
      "exp-a",
    ])
  })

  test("the default from Settings applies to projects without their own entry", async () => {
    await writeGecko()
    const project = await h.caller.projects.open({ path: h.repoDir })
    await h.caller.science.analysis.setStructure({
      projectId: null,
      value: "one-folder-per-experiment",
    })
    expect(experimentRuns(await list(project.id))["results/gecko/fl-shape_s0/run.db"]).toEqual([
      "gecko",
      null,
    ])
    expect(await h.caller.science.analysis.getStructure({ projectId: null })).toMatchObject({
      defaultValue: "one-folder-per-experiment",
      projectValue: null,
    })
  })

  test("a custom pattern matches folders, * and folder names", async () => {
    await writeRepoFile("results/sweep/seeds/s0/a.csv", "a\n1\n")
    await writeRepoFile("results/sweep/seeds/s1/deep/b.csv", "a\n1\n")
    await writeRepoFile("results/other/c.csv", "a\n1\n")
    const project = await h.caller.projects.open({ path: h.repoDir })
    await h.caller.science.analysis.setStructure({
      projectId: project.id,
      value: "{experiment}/*/{run}/",
    })
    expect(experimentRuns(await list(project.id))).toEqual({
      "results/sweep/seeds/s0/a.csv": ["sweep", "s0"],
      "results/sweep/seeds/s1/deep/b.csv": ["sweep", "s1"],
      "results/other/c.csv": ["other", null],
    })
    await h.caller.science.analysis.setStructure({
      projectId: project.id,
      value: "{experiment}/seeds/{run}",
    })
    expect(experimentRuns(await list(project.id))).toMatchObject({
      "results/sweep/seeds/s0/a.csv": ["sweep", "s0"],
      "results/other/c.csv": ["other", null],
    })
  })

  test("an unknown preset or invalid pattern is refused and the file is not changed", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await h.caller.science.analysis.setStructure({ projectId: project.id, value: "flat" })
    const before = await readFile(structurePath(), "utf8")
    for (const value of ["nested", "{experiment}/{experiment}", "a{run}", "*/x/"]) {
      await expect(
        h.caller.science.analysis.setStructure({ projectId: project.id, value }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    }
    expect(await readFile(structurePath(), "utf8")).toBe(before)
  })

  test("an invalid YAML file or unknown preset in the file is a visible error, never a fallback", async () => {
    await writeGecko()
    const project = await h.caller.projects.open({ path: h.repoDir })

    await writeFile(structurePath(), "default: [auto\nprojects: {\n")
    await expect(list(project.id)).rejects.toThrow(structurePath())
    await expect(
      h.caller.science.analysis.getStructure({ projectId: project.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    // An invalid file is never overwritten.
    await expect(
      h.caller.science.analysis.setStructure({ projectId: project.id, value: "flat" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect(await readFile(structurePath(), "utf8")).toBe("default: [auto\nprojects: {\n")

    await writeFile(structurePath(), `default: auto\nprojects:\n  ${project.repoPath}: nested\n`)
    await expect(list(project.id)).rejects.toThrow(/Unknown experiments structure "nested"/)

    await writeFile(structurePath(), "default: auto\nproject: {}\n")
    await expect(list(project.id)).rejects.toThrow(/unknown key "project"/)

    // A hand-written valid file is read as it is.
    await writeFile(
      structurePath(),
      `# mine\ndefault: flat\nprojects:\n  "${project.repoPath}": "{experiment}/"\n`,
    )
    expect(experimentRuns(await list(project.id))["results/gecko/fl-shape_s0/run.db"]).toEqual([
      "gecko",
      null,
    ])
  })
})

describe("science.analysis.listFiles", () => {
  test("leaves out render output (_render) and Quarto's .quarto folder", async () => {
    await writeRepoFile("results/report.qmd", "# R\n")
    await writeRepoFile("results/_render/report.qmd/report.html", "<h1>R</h1>")
    await writeRepoFile("results/_render/report.qmd/report_files/fig.png", TINY_PNG)
    await writeRepoFile("results/.quarto/xref/a.json", "{}")
    await writeRepoFile("results/metrics.csv", "a\n1\n")

    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })

    const paths = listing.groups.flatMap((group) => group.files.map((file) => file.relPath))
    expect(paths).toContain("results/metrics.csv")
    expect(paths.filter((path) => path.includes("_render") || path.includes(".quarto"))).toEqual([])
  })

  test("discovers and classifies data files, grouped by kind", async () => {
    await writeRepoFile("results/data/metrics.csv", "a,b\n1,2\n")
    await writeRepoFile("results/data/series.tsv", "x\ty\n1\t2\n")
    await writeRepoFile("results/config.json", '{"k":1}')
    await writeRepoFile("results/figs/plot.png", TINY_PNG)
    await writeRepoFile("results/analysis/explore.py", "print('hi')\n")
    await writeRepoFile("results/notes.md", "# notes\n")

    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })

    const kindByRel = new Map<string, string>()
    for (const group of listing.groups) {
      for (const file of group.files) kindByRel.set(file.relPath, group.kind)
    }

    expect(kindByRel.get("results/data/metrics.csv")).toBe("csv")
    expect(kindByRel.get("results/data/series.tsv")).toBe("tsv")
    expect(kindByRel.get("results/config.json")).toBe("json")
    expect(kindByRel.get("results/figs/plot.png")).toBe("image")
    expect(kindByRel.get("results/notes.md")).toBe("markdown")
    expect(kindByRel.has("results/analysis/explore.py")).toBe(false)

    // NumPy arrays get their own kinds.
    await writeRepoFile("results/runs/loss.npy", makeNpy([3], [0.5, 0.3, 0.1]))
    await writeRepoFile("results/checkpoints/weights.npz", Buffer.from([0x50, 0x4b]))
    const withNpy = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })
    const npyKind = new Map<string, string>()
    for (const group of withNpy.groups) {
      for (const file of group.files) npyKind.set(file.relPath, group.kind)
    }
    expect(npyKind.get("results/runs/loss.npy")).toBe("npy")
    expect(npyKind.get("results/checkpoints/weights.npz")).toBe("npz")

    expect(listing.truncatedGroups).toEqual([])
    expect(listing.total).toBeGreaterThanOrEqual(5)
  })

  test("discovers marimo notebooks but continues to exclude ordinary Python source", async () => {
    await writeRepoFile(
      "results/reports/live_notebook.py",
      "import marimo\n\napp = marimo.App()\n\nif __name__ == '__main__':\n    app.run()\n",
    )
    await writeRepoFile("results/reports/script.py", "import marimo\nprint('ordinary script')\n")

    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })
    const kindByRel = new Map<string, string>()
    for (const group of listing.groups) {
      for (const file of group.files) kindByRel.set(file.relPath, group.kind)
    }

    expect(kindByRel.get("results/reports/live_notebook.py")).toBe("marimo")
    expect(kindByRel.has("results/reports/script.py")).toBe(false)
  })

  test("recognizes a large marimo notebook from its bounded source prefix", async () => {
    await writeRepoFile(
      "results/reports/large.py",
      `import marimo\napp = marimo.App()\n${"# generated cell\n".repeat(6_000)}`,
    )
    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })

    expect(
      listing.groups
        .flatMap((group) => group.files)
        .find((file) => file.relPath === "results/reports/large.py")?.kind,
    ).toBe("marimo")
  })

  test("lists the scientific artifact whitelist and excludes source/unknown files", async () => {
    for (const relPath of [
      "results/data/table.arrow",
      "results/data/table.feather",
      "results/data/experiment.h5",
      "results/data/climate.nc",
      "results/data/results.sqlite",
      "results/data/results.xlsx",
      "results/reports/summary.html",
      "results/artifacts/model.pkl",
    ]) {
      await writeRepoFile(relPath, "fixture")
    }
    for (const relPath of [
      "results/src/analysis.py",
      "results/scripts/run.sh",
      "results/scripts/run.ps1",
      "results/scripts/run.bat",
      "results/build/native.dylib",
      "results/mystery.xyz",
    ]) {
      await writeRepoFile(relPath, "not an analysis artifact")
    }
    await mkdir(join(h.repoDir, "results", "runs", "arrays.zarr"), { recursive: true })

    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })
    const kindByRel = new Map(
      listing.groups.flatMap((group) =>
        group.files.map((file) => [file.relPath, file.kind] as const),
      ),
    )

    expect(kindByRel.get("results/data/experiment.h5")).toBe("dataset")
    expect(kindByRel.get("results/data/climate.nc")).toBe("dataset")
    expect(kindByRel.get("results/reports/summary.html")).toBe("report")
    expect(kindByRel.get("results/artifacts/model.pkl")).toBe("other")
    expect(kindByRel.get("results/runs/arrays.zarr")).toBe("dataset")
    expect([...kindByRel.keys()].some((path) => /\.(?:py|sh|ps1|bat|dylib|xyz)$/i.test(path))).toBe(
      false,
    )
  })

  test("skips .git and noise directories", async () => {
    await writeRepoFile("results/real.csv", "a\n1\n")
    await writeRepoFile("results/node_modules/pkg/data.csv", "junk\n")
    await writeRepoFile("results/__pycache__/cache.json", "{}")

    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })

    const allRel = listing.groups.flatMap((g) => g.files.map((f) => f.relPath))
    expect(allRel).toContain("results/real.csv")
    expect(allRel.some((r) => r.includes("node_modules"))).toBe(false)
    expect(allRel.some((r) => r.includes("__pycache__"))).toBe(false)
    expect(allRel.some((r) => r.startsWith(".git/"))).toBe(false)
  })

  test("keeps research outputs in build, out and dist", async () => {
    for (const folder of ["build", "out", "dist"]) {
      await writeRepoFile(`results/${folder}/result.npy`, makeNpy([1], [1]))
    }
    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })
    const paths = listing.groups.flatMap((group) => group.files.map((file) => file.relPath))
    expect(paths).toEqual(
      expect.arrayContaining([
        "results/build/result.npy",
        "results/out/result.npy",
        "results/dist/result.npy",
      ]),
    )
  })

  test("reports an unreadable child as a partial listing", async () => {
    await writeRepoFile("results/visible/data.csv", "a\n1\n")
    await writeRepoFile("results/private/data.csv", "a\n2\n")
    const project = await h.caller.projects.open({ path: h.repoDir })
    const privateDir = join(h.repoDir, "results", "private")
    await chmod(privateDir, 0)
    const listing = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })
    await chmod(privateDir, 0o755)
    expect(listing.groups.flatMap((group) => group.files.map((file) => file.relPath))).toContain(
      "results/visible/data.csv",
    )
    expect(listing.partial).toBe(true)
    expect(listing.skipped).toContain("results/private")
  })

  test("hides dotfiles (basename starting with a dot)", async () => {
    await writeRepoFile("results/real.csv", "a\n1\n")
    await writeRepoFile("results/.env", "SECRET=1\n")
    await writeRepoFile("results/config/.hidden.json", "{}")
    await writeRepoFile("results/.secret.csv", "a\n1\n")

    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })

    const allRel = listing.groups.flatMap((g) => g.files.map((f) => f.relPath))
    expect(allRel).toContain("results/real.csv")
    expect(allRel).not.toContain("results/.env")
    expect(allRel).not.toContain("results/config/.hidden.json")
    expect(allRel).not.toContain("results/.secret.csv")
    // No discovered file's basename starts with a dot.
    expect(allRel.every((r) => !r.slice(r.lastIndexOf("/") + 1).startsWith("."))).toBe(true)
  })

  test("the file cap is per list row, so every experiment is listed past 2000 files", async () => {
    // One run folder with more files than the cap, and a later experiment the walk
    // reaches only after it (breadth-first: zz-late's files come after bulk's).
    const count = MAX_LISTED_FILES + 5
    await Promise.all(
      Array.from({ length: count }, (_, i) => writeRepoFile(`results/bulk/f${i}.csv`, "a\n1\n")),
    )
    await writeRepoFile("results/zz-late/run-1/x.csv", "a\n1\n")

    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })
    const files = listing.groups.flatMap((group) => group.files)
    // Each file names its list row: the experiment, else the run.
    expect(files.filter((file) => file.listGroup === "bulk")).toHaveLength(MAX_LISTED_FILES)
    expect(files.find((file) => file.relPath === "results/zz-late/run-1/x.csv")?.listGroup).toBe(
      "zz-late",
    )
    // Only the row that was cut is flagged.
    expect(listing.truncatedGroups).toEqual([{ listGroup: "bulk", inReportsFolder: false }])
  })

  test("applies the cap after whitelist filtering so source-heavy repos cannot starve results", async () => {
    await Promise.all(
      Array.from({ length: MAX_LISTED_FILES + 5 }, (_, i) =>
        writeRepoFile(`results/source-${i}.py`, "print('source')\n"),
      ),
    )
    await writeRepoFile("results/deep/results/metrics.csv", "metric,value\nloss,0.1\n")

    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })
    const paths = listing.groups.flatMap((group) => group.files.map((file) => file.relPath))

    expect(paths).toContain("results/deep/results/metrics.csv")
    expect(paths.some((path) => path.endsWith(".py"))).toBe(false)
    expect(listing.truncatedGroups).toEqual([])
  })

  test("lists only the results folder, grouping files by experiment folder", async () => {
    await writeRepoFile("results/exp-a/plot.png", TINY_PNG)
    await writeRepoFile("results/exp-a/deep/metrics.csv", "a,b\n1,2\n")
    await writeRepoFile("results/exp-b/log.txt", "step 1\n")
    await writeRepoFile("results/summary.json", "{}")
    await writeRepoFile("data/outside.csv", "a\n1\n")

    const project = await h.caller.projects.open({ path: h.repoDir })
    await h.caller.science.analysis.setStructure({
      projectId: project.id,
      value: "one-folder-per-experiment",
    })
    const listing = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })

    expect(listing.resultsFolder).toBe("results")
    expect(listing.overridden).toBe(false)
    expect(listing.exists).toBe(true)
    const experimentByRel = new Map(
      listing.groups.flatMap((group) =>
        group.files.map((file) => [file.relPath, file.experiment] as const),
      ),
    )
    expect(Object.fromEntries(experimentByRel)).toEqual({
      "results/exp-a/plot.png": "exp-a",
      "results/exp-a/deep/metrics.csv": "exp-a",
      "results/exp-b/log.txt": "exp-b",
      "results/summary.json": null,
    })
  })

  test("uses the default folder from Settings when it is not results/", async () => {
    await writeRepoFile("outputs/run-1/log.txt", "x\n")
    await writeRepoFile("results/exp-a/log.txt", "x\n")
    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "outputs",
    })
    expect(listing.resultsFolder).toBe("outputs")
    expect(listing.groups.flatMap((g) => g.files.map((f) => f.relPath))).toEqual([
      "outputs/run-1/log.txt",
    ])
  })

  test("a project's own results folder overrides the default, is kept by setMetadata, and can be reset", async () => {
    await writeRepoFile("runs/out/exp-c/log.txt", "x\n")
    await writeRepoFile("results/exp-a/log.txt", "x\n")
    const project = await h.caller.projects.open({ path: h.repoDir })

    const saved = await h.caller.science.analysis.setResultsFolder({
      projectId: project.id,
      dir: join(h.repoDir, "runs", "out"),
    })
    expect(saved.resultsFolder).toBe("runs/out")
    // The card's "Edit project…" dialog rewrites the metadata; the folder stays.
    await h.caller.projects.setMetadata({ id: project.id, metadata: { venue: "NeurIPS" } })

    const listing = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })
    expect(listing.resultsFolder).toBe("runs/out")
    expect(listing.overridden).toBe(true)
    expect(
      listing.groups.flatMap((g) => g.files.map((f) => [f.relPath, f.experiment, f.run])),
    ).toEqual([["runs/out/exp-c/log.txt", null, "exp-c"]])

    await h.caller.science.analysis.setResultsFolder({ projectId: project.id, dir: null })
    const reset = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })
    expect(reset.resultsFolder).toBe("results")
    expect(reset.overridden).toBe(false)
    const stored = (await h.caller.projects.list()).find((p) => p.id === project.id)
    expect(stored?.metadata).toEqual({ venue: "NeurIPS" })
  })

  test("a missing results folder is reported as missing, not as an empty list", async () => {
    await writeRepoFile("data/metrics.csv", "a\n1\n")
    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })
    expect(listing.exists).toBe(false)
    expect(listing.resultsFolder).toBe("results")
    expect(listing.total).toBe(0)
    expect(listing.groups).toEqual([])
  })

  test("also lists the project's reports/ folder as its own group", async () => {
    await writeRepoFile("results/exp-a/log.txt", "x\n")
    await writeRepoFile("results/reports/inner.html", "<p>experiment</p>")
    await writeRepoFile("reports/report.html", "<p>report</p>")
    await writeRepoFile("reports/nested/summary.md", "# summary\n")
    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })
    const byRel = Object.fromEntries(
      listing.groups.flatMap((group) =>
        group.files.map(
          (file) => [file.relPath, [file.experiment, file.run, file.inReportsFolder]] as const,
        ),
      ),
    )
    expect(byRel).toEqual({
      "results/exp-a/log.txt": [null, "exp-a", false],
      // A reports/ folder inside the results folder stays a run of the results folder.
      "results/reports/inner.html": [null, "reports", false],
      "reports/report.html": [null, null, true],
      "reports/nested/summary.md": [null, null, true],
    })
    expect(listing.total).toBe(4)
  })

  test("reports/ is listed once when it is the results folder or contains it", async () => {
    await writeRepoFile("reports/exp-a/log.txt", "x\n")
    await writeRepoFile("reports/report.html", "<p>report</p>")
    const project = await h.caller.projects.open({ path: h.repoDir })
    for (const defaultResultsFolder of ["reports", "reports/exp-a"]) {
      const listing = await h.caller.science.analysis.listFiles({
        projectId: project.id,
        defaultResultsFolder,
      })
      const rels = listing.groups.flatMap((group) => group.files.map((file) => file.relPath))
      expect(rels.sort()).toEqual(["reports/exp-a/log.txt", "reports/report.html"])
      expect(listing.total).toBe(2)
    }
  })

  test("reports/ is still listed when the results folder is missing; no reports/ is no group", async () => {
    await writeRepoFile("reports/report.html", "<p>report</p>")
    const project = await h.caller.projects.open({ path: h.repoDir })
    const listing = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })
    expect(listing.exists).toBe(false)
    expect(listing.groups.flatMap((g) => g.files.map((f) => f.relPath))).toEqual([
      "reports/report.html",
    ])

    await writeRepoFile("results/exp-a/log.txt", "x\n")
    await rm(join(h.repoDir, "reports"), { recursive: true })
    const noReports = await h.caller.science.analysis.listFiles({
      projectId: project.id,
      defaultResultsFolder: "results",
    })
    expect(noReports.groups.flatMap((g) => g.files.every((f) => !f.inReportsFolder))).toEqual([
      true,
    ])
  })

  test("refuses results folders outside the project", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    for (const defaultResultsFolder of ["../elsewhere", "/tmp", "."]) {
      await expect(
        h.caller.science.analysis.listFiles({ projectId: project.id, defaultResultsFolder }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
    }
    for (const dir of [join(h.repoDir, ".."), h.repoDir, "relative/path"]) {
      await expect(
        h.caller.science.analysis.setResultsFolder({ projectId: project.id, dir }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
    }
    // A symlink inside the project that points outside it is refused too.
    await symlink(join(h.repoDir, ".."), join(h.repoDir, "linked"))
    await expect(
      h.caller.science.analysis.listFiles({
        projectId: project.id,
        defaultResultsFolder: "linked",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      h.caller.science.analysis.setResultsFolder({
        projectId: project.id,
        dir: join(h.repoDir, "linked"),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  test("an unknown projectId is a clean NOT_FOUND", async () => {
    await expect(
      h.caller.science.analysis.listFiles({
        projectId: "missing",
        defaultResultsFolder: "results",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("science.analysis PDF preview", () => {
  test("pdfStat and pdf read a project PDF for the bundled PDF.js viewer", async () => {
    const body = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"
    await writeRepoFile("results/multiplexing/run/gradient.pdf", body)
    await writeRepoFile("results/multiplexing/run/notes.txt", "x\n")
    const project = await h.caller.projects.open({ path: h.repoDir })
    const input = { projectId: project.id, relPath: "results/multiplexing/run/gradient.pdf" }

    const stat = await h.caller.science.analysis.pdfStat(input)
    expect(stat).toMatchObject({ exists: true, size: body.length })
    const snapshot = await h.caller.science.analysis.pdf(input)
    expect(Buffer.from(snapshot.data).toString("utf8")).toBe(body)
    expect(snapshot.baseline).toEqual({ mtimeMs: stat.mtimeMs, size: stat.size })

    await expect(
      h.caller.science.analysis.pdf({ ...input, relPath: "results/multiplexing/run/notes.txt" }),
    ).rejects.toThrow("Select a PDF file")
    await expect(
      h.caller.science.analysis.pdf({ ...input, relPath: "../outside.pdf" }),
    ).rejects.toThrow()
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
  test("creates a ready-to-run marimo notebook under reports without overwriting an existing file", async () => {
    await writeRepoFile("reports/notebook.py", "existing")
    const project = await h.caller.projects.open({ path: h.repoDir })

    const notebook = await h.caller.science.analysis.createTemplate({
      projectId: project.id,
      kind: "marimo",
    })

    expect(notebook).toEqual({ relPath: "reports/notebook-1.py" })
    expect(await readFile(join(h.repoDir, notebook.relPath), "utf8")).toContain(
      "app = marimo.App()",
    )
    expect(await readFile(join(h.repoDir, "reports/notebook.py"), "utf8")).toBe("existing")
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

  test("markup (YAML, XML) → head, like text", async () => {
    await writeRepoFile("config.yaml", "lr: 0.1\n")
    await writeRepoFile("layout.xml", "<a/>\n")
    const project = await h.caller.projects.open({ path: h.repoDir })
    for (const [relPath, text] of [
      ["config.yaml", "lr: 0.1\n"],
      ["layout.xml", "<a/>\n"],
    ] as const) {
      const preview = await h.caller.science.analysis.preview({ projectId: project.id, relPath })
      expect(preview).toEqual({ type: "text", text, truncated: false })
    }
  })

  test(".ipynb → its cells with the stored outputs", async () => {
    const notebook = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { cell_type: "markdown", metadata: {}, source: "# Loss" },
        {
          cell_type: "code",
          metadata: {},
          execution_count: 1,
          source: "print(0.3)",
          outputs: [{ output_type: "stream", name: "stdout", text: "0.3\n" }],
        },
      ],
    }
    await writeRepoFile("results/run/analysis.ipynb", JSON.stringify(notebook))
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "results/run/analysis.ipynb",
    })
    expect(preview).toEqual({
      type: "notebook",
      cells: [
        { type: "markdown", source: "# Loss", outputs: [] },
        { type: "code", source: "print(0.3)", outputs: [{ type: "text", text: "0.3\n" }] },
      ],
    })
  })

  test(".qmd → text, like Markdown", async () => {
    await writeRepoFile("results/run/analysis.qmd", "---\ntitle: Run\n---\n\n# Result\n")
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "results/run/analysis.qmd",
    })
    expect(preview).toEqual({
      type: "text",
      text: "---\ntitle: Run\n---\n\n# Result\n",
      truncated: false,
    })
  })

  test("a marimo notebook → its Python source as text", async () => {
    const source = "import marimo\n\napp = marimo.App()\n"
    await writeRepoFile("results/run/notebook.py", source)
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "results/run/notebook.py",
    })
    expect(preview).toEqual({ type: "text", text: source, truncated: false })
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

  test.each([
    ["<f8", "setFloat64", 8, -1.25],
    [">f4", "setFloat32", 4, -1.25],
    ["<i8", "setBigInt64", 8, -12],
    [">i4", "setInt32", 4, -12],
    ["<i2", "setInt16", 2, -12],
    ["|i1", "setInt8", 1, -12],
    [">u8", "setBigUint64", 8, 12],
    ["<u4", "setUint32", 4, 12],
    [">u2", "setUint16", 2, 12],
    ["|u1", "setUint8", 1, 12],
  ] as const)("decodes dtype %s through preview", async (descr, setter, width, value) => {
    const data = Buffer.alloc(width)
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const numeric = setter.includes("Big") ? BigInt(value) : value
    if (width === 1) {
      ;(view[setter] as (offset: number, value: never) => void)(0, numeric as never)
    } else {
      ;(view[setter] as (offset: number, value: never, littleEndian: boolean) => void)(
        0,
        numeric as never,
        descr.startsWith("<"),
      )
    }
    await writeRepoFile("dtype.npy", makeRawNpy("1,", descr, false, data))
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "dtype.npy",
    })
    if (preview.type !== "chart") throw new Error("expected chart")
    expect(preview.series[0]?.values).toEqual([value])
  })

  test("Fortran order and nonfinite values preserve the visible grid", async () => {
    const data = Buffer.alloc(6 * 8)
    const values = [1, 4, Number.NaN, 5, 3, Number.POSITIVE_INFINITY]
    values.forEach((value, index) => {
      data.writeDoubleBE(value, index * 8)
    })
    await writeRepoFile("fortran.npy", makeRawNpy("2, 3", ">f8", true, data))
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "fortran.npy",
    })
    if (preview.type !== "array") throw new Error("expected array")
    expect(preview.rows).toEqual([
      ["1", "", "3"],
      ["4", "5", ""],
    ])
  })

  test("large chart decodes only sampled values", async () => {
    const count = 1_000_000
    const data = Buffer.alloc(count * 8)
    data.writeDoubleLE(17, 0)
    data.writeDoubleLE(29, 1000 * 8)
    await writeRepoFile("sample.npy", makeRawNpy(`${count},`, "<f8", false, data))
    const reads = vi.spyOn(DataView.prototype, "getFloat64")
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "sample.npy",
    })
    const readCount = reads.mock.calls.length
    reads.mockRestore()
    if (preview.type !== "chart") throw new Error("expected chart")
    expect(preview.x).toHaveLength(MAX_CHART_POINTS)
    expect(preview.series[0]?.values.slice(0, 2)).toEqual([17, 29])
    expect(readCount).toBeLessThanOrEqual(MAX_CHART_POINTS)
  })

  test("large grid decodes only visible cells", async () => {
    const data = Buffer.alloc(1000 * 1000 * 8)
    data.writeDoubleLE(11, 0)
    data.writeDoubleLE(22, 1000 * 8)
    await writeRepoFile("grid.npy", makeRawNpy("1000, 1000", "<f8", false, data))
    const project = await h.caller.projects.open({ path: h.repoDir })
    const reads = vi.spyOn(DataView.prototype, "getFloat64")
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "grid.npy",
    })
    const readCount = reads.mock.calls.length
    reads.mockRestore()
    if (preview.type !== "array") throw new Error("expected array")
    expect(preview.rows).toHaveLength(200)
    expect(preview.columns).toHaveLength(32)
    expect(preview.rows[0]?.[0]).toBe("11")
    expect(preview.rows[1]?.[0]).toBe("22")
    expect(readCount).toBeLessThanOrEqual(200 * 32)
  })

  test.each([
    "1.5",
    "-1,",
    "2.2,",
    "9007199254740992,",
    "2, 9007199254740991",
  ])("rejects malformed or unsafe shape %s", async (shape) => {
    await writeRepoFile("bad-shape.npy", makeRawNpy(shape, "<f8", false, Buffer.alloc(8)))
    const project = await h.caller.projects.open({ path: h.repoDir })
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "bad-shape.npy",
    })
    expect(preview.type).toBe("metadata")
  })

  test("rejects an out-of-bounds header and an unsupported version", async () => {
    const badHeader = makeRawNpy("1,", "<f8", false, Buffer.alloc(8))
    badHeader.writeUInt16LE(65535, 8)
    const badVersion = makeRawNpy("1,", "<f8", false, Buffer.alloc(8))
    badVersion[7] = 99
    await writeRepoFile("bad-header.npy", badHeader)
    await writeRepoFile("bad-version.npy", badVersion)
    const project = await h.caller.projects.open({ path: h.repoDir })
    for (const relPath of ["bad-header.npy", "bad-version.npy"]) {
      const preview = await h.caller.science.analysis.preview({ projectId: project.id, relPath })
      expect(preview.type).toBe("metadata")
    }
  })

  test("rejects a very high-rank header without expanding its dimensions", async () => {
    const shape = `${"1, ".repeat(100_000)}1`
    const header = `{'descr': '<f8', 'fortran_order': False, 'shape': (${shape}), }\n`
    const prefix = Buffer.alloc(12)
    prefix[0] = 0x93
    prefix.write("NUMPY", 1, "ascii")
    prefix[6] = 2
    prefix.writeUInt32LE(header.length, 8)
    await writeRepoFile("high-rank.npy", Buffer.concat([prefix, Buffer.from(header, "ascii")]))
    const project = await h.caller.projects.open({ path: h.repoDir })
    const maps = vi.spyOn(Array.prototype, "map")
    const preview = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "high-rank.npy",
    })
    const expandedShape = maps.mock.contexts.some(
      (context) => Array.isArray(context) && context.length >= 100_000,
    )
    maps.mockRestore()
    expect(preview.type).toBe("metadata")
    expect(expandedShape).toBe(false)
  })

  test("zero dimensions remain valid and the source cap returns metadata", async () => {
    await writeRepoFile("empty.npy", makeRawNpy("0, 3", "<f8", false, Buffer.alloc(0)))
    await writeRepoFile("oversized.npy", Buffer.alloc(MAX_NPY_BYTES + 1))
    const project = await h.caller.projects.open({ path: h.repoDir })
    const empty = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "empty.npy",
    })
    if (empty.type !== "array") throw new Error("expected array")
    expect(empty.rows).toEqual([])
    const oversized = await h.caller.science.analysis.preview({
      projectId: project.id,
      relPath: "oversized.npy",
    })
    expect(oversized.type).toBe("metadata")
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
