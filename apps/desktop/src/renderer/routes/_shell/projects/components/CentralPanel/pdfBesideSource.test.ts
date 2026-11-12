import { describe, expect, test } from "vitest"
import { pdfBesideSource } from "./pdfBesideSource"

describe("pdfBesideSource", () => {
  test("a PDF opens to the right of the open LaTeX source", () => {
    expect(pdfBesideSource("file:build/main.pdf", ["main.tex"])).toEqual({
      referencePanel: "file:main.tex",
      direction: "right",
    })
  })

  test("a second PDF joins the split of the PDF already open", () => {
    expect(pdfBesideSource("file:build/other.pdf", ["main.tex", "build/main.pdf"])).toEqual({
      referencePanel: "file:build/main.pdf",
      direction: "within",
    })
  })

  test("the PDF being added is not used as its own reference", () => {
    expect(pdfBesideSource("file:build/main.pdf", ["main.tex", "build/main.pdf"])).toEqual({
      referencePanel: "file:main.tex",
      direction: "right",
    })
  })

  test("other tabs, or a PDF with no source open, use the default placement", () => {
    expect(pdfBesideSource("file:sections/intro.tex", ["main.tex"])).toBeUndefined()
    expect(pdfBesideSource("file:build/main.pdf", ["refs.bib"])).toBeUndefined()
    expect(pdfBesideSource("session:abc", ["main.tex"])).toBeUndefined()
  })
})
