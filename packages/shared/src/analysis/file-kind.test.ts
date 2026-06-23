import fc from "fast-check"
import { describe, expect, test } from "vitest"
import {
  ALL_DATA_FILE_KINDS,
  classifyDataFile,
  type DataFileKind,
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

  test("classifies markdown and text/log", () => {
    expect(classifyDataFile("RESEARCH.md")).toBe("markdown")
    expect(classifyDataFile("run.log")).toBe("text")
    expect(classifyDataFile("params.yaml")).toBe("text")
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

describe("isPreviewableKind", () => {
  test("previewable kinds render inline; others are metadata-only", () => {
    expect(isPreviewableKind("csv")).toBe(true)
    expect(isPreviewableKind("tsv")).toBe(true)
    expect(isPreviewableKind("json")).toBe(true)
    expect(isPreviewableKind("image")).toBe(true)
    expect(isPreviewableKind("markdown")).toBe(true)
    expect(isPreviewableKind("text")).toBe(true)

    expect(isPreviewableKind("parquet")).toBe(false)
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
