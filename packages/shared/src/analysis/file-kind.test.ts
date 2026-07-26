import fc from "fast-check"
import { describe, expect, test } from "vitest"
import {
  ALL_DATA_FILE_CATEGORIES,
  ALL_DATA_FILE_KINDS,
  categoryOf,
  classifyAnalysisArtifact,
  classifyDataFile,
  DATA_FILE_CATEGORY_LABELS,
  type DataFileCategory,
  type DataFileKind,
  isMarimoNotebookSource,
  isPreviewableKind,
} from "./file-kind"

describe("classifyDataFile", () => {
  // Example-based: pin down the concrete, human-meaningful mapping.
  test("classifies tabular extensions", () => {
    expect(classifyDataFile("results/metrics.csv")).toBe("csv")
    expect(classifyDataFile("data.tsv")).toBe("tsv")
    expect(classifyDataFile("data.tab")).toBe("tsv")
  })

  test("classifies structured-data extensions", () => {
    expect(classifyDataFile("config.json")).toBe("json")
    expect(classifyDataFile("events.jsonl")).toBe("json")
    expect(classifyDataFile("stream.ndjson")).toBe("json")
    expect(classifyDataFile("regions.geojson")).toBe("json")
  })

  test("classifies images, notebooks, parquet, and plots", () => {
    expect(classifyDataFile("figs/loss.png")).toBe("image")
    expect(classifyDataFile("diagram.svg")).toBe("image")
    expect(classifyDataFile("explore.ipynb")).toBe("notebook")
    expect(classifyDataFile("table.parquet")).toBe("parquet")
    expect(classifyDataFile("table.feather")).toBe("parquet")
    expect(classifyDataFile("figure.pdf")).toBe("plot")
  })

  test("classifies NumPy arrays", () => {
    expect(classifyDataFile("runs/loss.npy")).toBe("npy")
    expect(classifyDataFile("checkpoints/weights.npz")).toBe("npz")
  })

  test("classifies markdown and text/log", () => {
    expect(classifyDataFile("RESEARCH.md")).toBe("markdown")
    expect(classifyDataFile("run.log")).toBe("text")
    expect(classifyDataFile("params.yaml")).toBe("text")
  })

  test("whitelists scientific stores, reports, and explicit metadata-only pickle artifacts", () => {
    for (const path of [
      "results/data.h5",
      "results/data.hdf5",
      "results/climate.nc",
      "results/table.sqlite",
      "results/table.db",
      "results/workbook.xlsx",
      "reports/summary.html",
    ]) {
      expect(classifyAnalysisArtifact(path, "file")).not.toBeNull()
    }
    expect(classifyAnalysisArtifact("runs/store.zarr", "directory")).toBe("dataset")
    expect(classifyAnalysisArtifact("runs/model.pkl", "file")).toBe("other")
    expect(classifyAnalysisArtifact("runs/model.pickle", "file")).toBe("other")
  })

  test("rejects source, compiled, unknown, and non-Zarr directory entries", () => {
    for (const path of [
      "analysis.py",
      "run.sh",
      "run.ps1",
      "run.bat",
      "native.dylib",
      "binary.exe",
      "a.out",
      "unknown.xyz",
      "README",
    ]) {
      expect(classifyAnalysisArtifact(path, "file")).toBeNull()
    }
    expect(classifyAnalysisArtifact("results", "directory")).toBeNull()
  })

  test("recognizes marimo notebook source without admitting ordinary Python source", () => {
    expect(
      isMarimoNotebookSource(
        "import marimo\n\n__generated_with = '0.14.0'\napp = marimo.App(width='medium')\n",
      ),
    ).toBe(true)
    expect(isMarimoNotebookSource("import marimo as mo\napp = mo.App()\n")).toBe(true)
    expect(isMarimoNotebookSource("from marimo import App\napp = App()\n")).toBe(true)
    expect(isMarimoNotebookSource("import marimo\nprint('not a notebook')\n")).toBe(false)
    expect(isMarimoNotebookSource("print('ordinary source')\n")).toBe(false)
  })

  test("is case-insensitive on the extension", () => {
    expect(classifyDataFile("METRICS.CSV")).toBe("csv")
    expect(classifyDataFile("Figure.PNG")).toBe("image")
    expect(classifyDataFile("Notebook.IpYnB")).toBe("notebook")
  })

  test("uses only the final extension of the final path segment", () => {
    expect(classifyDataFile("a.csv/b.png")).toBe("image")
    expect(classifyDataFile("archive.tar.csv")).toBe("csv")
    expect(classifyDataFile("C:\\runs\\out.json")).toBe("json")
  })

  test("unrecognized, extension-less, and dotfile paths are 'other'", () => {
    expect(classifyDataFile("")).toBe("other")
    expect(classifyDataFile("README")).toBe("other")
    expect(classifyDataFile("Makefile")).toBe("other")
    expect(classifyDataFile(".gitignore")).toBe("other")
    expect(classifyDataFile("trailing.")).toBe("other")
    expect(classifyDataFile("binary.xyz")).toBe("other")
    expect(classifyDataFile("dir/")).toBe("other")
  })

  // Property-based: invariants that must hold for ALL string inputs.
  const kinds = new Set<DataFileKind>(ALL_DATA_FILE_KINDS)

  test("never throws and always returns a kind in the enum", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const kind = classifyDataFile(input)
        return kinds.has(kind)
      }),
    )
  })

  test("is deterministic — same input, same output", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const first = classifyDataFile(input)
        const second = classifyDataFile(input)
        return first === second
      }),
    )
  })

  test("is case-insensitive for arbitrary paths", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        return classifyDataFile(input.toLowerCase()) === classifyDataFile(input.toUpperCase())
      }),
    )
  })

  test("a known extension classifies regardless of the stem", () => {
    const knownSamples: Array<[string, DataFileKind]> = [
      ["csv", "csv"],
      ["tsv", "tsv"],
      ["json", "json"],
      ["png", "image"],
      ["ipynb", "notebook"],
      ["parquet", "parquet"],
      ["npy", "npy"],
      ["npz", "npz"],
      ["pdf", "plot"],
      ["md", "markdown"],
      ["log", "text"],
    ]
    fc.assert(
      fc.property(
        // A stem with no separators and no dots so the extension is unambiguous.
        fc.stringMatching(/^[a-zA-Z0-9_-]+$/),
        fc.constantFrom(...knownSamples),
        (stem, [ext, expected]) => classifyDataFile(`${stem}.${ext}`) === expected,
      ),
    )
  })

  test("appending an unknown extension to any path yields 'other'", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9_-]+$/), (stem) => {
        return classifyDataFile(`${stem}.zzqq`) === "other"
      }),
    )
  })
})

describe("categoryOf", () => {
  test("collapses tabular/structured/array kinds into 'data'", () => {
    expect(categoryOf("csv")).toBe("data")
    expect(categoryOf("tsv")).toBe("data")
    expect(categoryOf("json")).toBe("data")
    expect(categoryOf("parquet")).toBe("data")
    expect(categoryOf("npy")).toBe("data")
    expect(categoryOf("npz")).toBe("data")
  })

  test("maps the remaining kinds to their own categories", () => {
    expect(categoryOf("image")).toBe("image")
    expect(categoryOf("notebook")).toBe("notebook")
    expect(categoryOf("marimo")).toBe("notebook")
    expect(categoryOf("plot")).toBe("plot")
    expect(categoryOf("markdown")).toBe("text")
    expect(categoryOf("text")).toBe("text")
    expect(categoryOf("other")).toBe("other")
  })

  test("returns a category in the enum for every kind", () => {
    const categories = new Set<DataFileCategory>(ALL_DATA_FILE_CATEGORIES)
    for (const kind of ALL_DATA_FILE_KINDS) {
      expect(categories.has(categoryOf(kind))).toBe(true)
    }
  })
})

describe("category metadata", () => {
  test("'other' is the last category in canonical order", () => {
    expect(ALL_DATA_FILE_CATEGORIES[ALL_DATA_FILE_CATEGORIES.length - 1]).toBe("other")
  })

  test("every category present via categoryOf is in ALL_DATA_FILE_CATEGORIES", () => {
    const ordered = new Set<DataFileCategory>(ALL_DATA_FILE_CATEGORIES)
    for (const kind of ALL_DATA_FILE_KINDS) {
      expect(ordered.has(categoryOf(kind))).toBe(true)
    }
  })

  test("labels exist for every category", () => {
    for (const category of ALL_DATA_FILE_CATEGORIES) {
      expect(DATA_FILE_CATEGORY_LABELS[category]).toBeTruthy()
    }
    expect(DATA_FILE_CATEGORY_LABELS.data).toBe("Data")
    expect(DATA_FILE_CATEGORY_LABELS.image).toBe("Images")
  })
})

describe("isPreviewableKind", () => {
  test("previewable kinds render inline; others are metadata-only", () => {
    expect(isPreviewableKind("csv")).toBe(true)
    expect(isPreviewableKind("tsv")).toBe(true)
    expect(isPreviewableKind("json")).toBe(true)
    expect(isPreviewableKind("image")).toBe(true)
    expect(isPreviewableKind("markdown")).toBe(true)
    expect(isPreviewableKind("text")).toBe(true)
    expect(isPreviewableKind("npy")).toBe(true)
    expect(isPreviewableKind("report")).toBe(true)
    expect(isPreviewableKind("marimo")).toBe(true)

    expect(isPreviewableKind("parquet")).toBe(false)
    expect(isPreviewableKind("npz")).toBe(false)
    expect(isPreviewableKind("plot")).toBe(false)
    expect(isPreviewableKind("notebook")).toBe(false)
    expect(isPreviewableKind("other")).toBe(false)
  })

  test("returns a boolean for every kind", () => {
    for (const kind of ALL_DATA_FILE_KINDS) {
      expect(typeof isPreviewableKind(kind)).toBe("boolean")
    }
  })
})
