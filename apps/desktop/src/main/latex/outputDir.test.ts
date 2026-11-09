import { describe, expect, test } from "vitest"
import { normalizeOutputDir, outputDirProblem, outputExcludePatterns } from "./outputDir"

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

describe("outputDirProblem", () => {
  test("rejects names Git exclude rules would read as something else, in plain English", () => {
    expect(outputDirProblem("#out")).toBe(
      "A folder name in the build output folder cannot start with # or !: #out",
    )
    expect(outputDirProblem("out/!pdf")).toBe(
      "A folder name in the build output folder cannot start with # or !: out/!pdf",
    )
    for (const value of ["out*", "o?t", "out[1]", "a]b"]) {
      expect(outputDirProblem(value)).toBe(
        `The build output folder cannot contain *, ?, [ or ]: ${value}`,
      )
    }
    for (const value of ["out\npdf", "out\tx", "a\u0007b"]) {
      expect(outputDirProblem(value)).toBe(
        "The build output folder cannot contain line breaks or other control characters",
      )
    }
    for (const value of [".git", "out/.git", ".git/out", "./.GIT"]) {
      expect(outputDirProblem(value)).toBe(
        `The build output folder cannot be or contain a .git folder: ${value}`,
      )
    }
    for (const value of ["out\\pdf", "\\#out", "out\\ x"]) {
      expect(outputDirProblem(value)).toBe(
        `Use / to separate folders in the build output folder, not \\: ${value}`,
      )
    }
    expect(outputDirProblem("out/pdf-2 (final)")).toBeNull()
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
