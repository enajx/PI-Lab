import { language } from "@codemirror/language"
import { EditorState, type Extension } from "@codemirror/state"
import { describe, expect, test } from "vitest"
import { extensionOf, languageForPath } from "./languageForPath"

describe("extensionOf", () => {
  test("returns the lower-cased final extension", () => {
    expect(extensionOf("main.PY")).toBe("py")
    expect(extensionOf("src/lib/util.py")).toBe("py")
  })

  test("returns '' for a path with no extension", () => {
    expect(extensionOf("Makefile")).toBe("")
    expect(extensionOf("src/README")).toBe("")
  })

  test("treats a leading dot as a dotfile, not an extension", () => {
    expect(extensionOf(".gitignore")).toBe("")
    expect(extensionOf("src/.env")).toBe("")
  })

  test("uses only the final segment's extension", () => {
    expect(extensionOf("a.b/c.py")).toBe("py")
    expect(extensionOf("archive.tar/file")).toBe("")
  })
})

describe("languageForPath", () => {
  test("returns a LaTeX (stex) language for .tex, .sty, .cls and .bib", () => {
    for (const path of ["paper.tex", "style.sty", "doc.cls", "refs.bib", "a/B.TEX"]) {
      const ext = languageForPath(path)
      expect(ext, path).not.toBeNull()
      const state = EditorState.create({ doc: "\\section{A} % c", extensions: [ext as Extension] })
      expect(state.facet(language)?.name, path).toBe("stex")
    }
  })

  test("returns a Python extension for .py and friends", () => {
    expect(languageForPath("main.py")).not.toBeNull()
    expect(languageForPath("stub.pyi")).not.toBeNull()
    expect(languageForPath("win.pyw")).not.toBeNull()
  })

  test("returns a C++ extension for common C++ source and header extensions", () => {
    for (const path of [
      "main.c",
      "main.h",
      "main.cc",
      "main.hh",
      "main.cpp",
      "main.hpp",
      "main.cxx",
      "main.hxx",
    ]) {
      expect(languageForPath(path), path).not.toBeNull()
    }
  })

  test("returns null for unsupported files (plain text)", () => {
    expect(languageForPath("notes.md")).toBeNull()
    expect(languageForPath("app.ts")).toBeNull()
    expect(languageForPath("data.json")).toBeNull()
    expect(languageForPath("Makefile")).toBeNull()
  })
})
