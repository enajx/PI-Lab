import { describe, expect, test } from "vitest"
import { normalizeOutputDir, outputExcludePatterns } from "./outputDir"

describe("normalizeOutputDir", () => {
  test("accepts relative folders and '.', and tidies them", () => {
    expect(normalizeOutputDir("build")).toBe("build")
    expect(normalizeOutputDir(" out/pdf/ ")).toBe("out/pdf")
    expect(normalizeOutputDir("./out")).toBe("out")
    expect(normalizeOutputDir(".")).toBe(".")
    expect(normalizeOutputDir("./")).toBe(".")
  })

  test("rejects empty, absolute and '..' paths with a readable message", () => {
    expect(() => normalizeOutputDir("  ")).toThrow("Enter a folder")
    expect(() => normalizeOutputDir("/tmp/out")).toThrow("relative")
    expect(() => normalizeOutputDir("C:\\out")).toThrow("relative")
    expect(() => normalizeOutputDir("../out")).toThrow("..")
    expect(() => normalizeOutputDir("a/../../out")).toThrow("..")
    expect(() => normalizeOutputDir("a/..")).toThrow("..")
  })
})

describe("outputExcludePatterns", () => {
  test("a folder is excluded wherever a root .tex builds into it", () => {
    expect(outputExcludePatterns("build", "main.tex")).toEqual(["build/"])
    expect(outputExcludePatterns("out/pdf", null)).toEqual(["**/out/pdf/"])
  })

  test("'.' excludes the root PDF by name and build-only files anywhere, never sources", () => {
    expect(outputExcludePatterns(".", "main.tex")).toEqual([
      "/main.pdf",
      "*.aux",
      "*.log",
      "*.synctex.gz",
      "*.fls",
      "*.fdb_latexmk",
      "*.out",
      "*.toc",
      "*.bbl",
      "*.blg",
    ])
    expect(outputExcludePatterns(".", "sub/paper.tex")[0]).toBe("/sub/paper.pdf")
    // .aux files of \include'd chapters in subfolders are covered too.
    expect(outputExcludePatterns(".", null)).toEqual(
      outputExcludePatterns(".", "main.tex").slice(1),
    )
  })
})
