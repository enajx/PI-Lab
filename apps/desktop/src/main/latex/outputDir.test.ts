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
  test("a folder is excluded only next to the root .tex, anchored to the paper folder", () => {
    expect(outputExcludePatterns("build", "main.tex")).toEqual(["/build/"])
    expect(outputExcludePatterns("out/pdf", "sub/paper.tex")).toEqual(["/sub/out/pdf/"])
    expect(outputExcludePatterns("build", null)).toEqual(["/build/"])
  })

  test("'.' excludes the root's own outputs by name and .aux files below it, never sources", () => {
    expect(outputExcludePatterns(".", "main.tex")).toEqual([
      "/main.pdf",
      "/main.aux",
      "/main.log",
      "/main.synctex.gz",
      "/main.fls",
      "/main.fdb_latexmk",
      "/main.out",
      "/main.toc",
      "/main.bbl",
      "/main.blg",
      // .aux files of \include'd chapters in subfolders.
      "/**/*.aux",
    ])
    expect(outputExcludePatterns(".", "sub/paper.tex")).toContain("/sub/paper.pdf")
    expect(outputExcludePatterns(".", "sub/paper.tex").at(-1)).toBe("/sub/**/*.aux")
    // With no root .tex known there is nothing built yet to exclude.
    expect(outputExcludePatterns(".", null)).toEqual([])
  })
})
