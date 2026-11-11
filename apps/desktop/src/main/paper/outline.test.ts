// Unit tests for the pure LaTeX outline parser. Files are given as an in-memory map.
import { expect, test } from "vitest"
import { buildOutline } from "./outline"

/** Reader over an in-memory file map; missing files read as null. */
function reader(files: Record<string, string>): (relPath: string) => string | null {
  return (relPath) => files[relPath] ?? null
}

test("headings at every level, starred and with short titles, with 1-based lines", () => {
  const source = [
    "\\documentclass{article}",
    "\\part{Intro part}",
    "\\chapter{First}",
    "\\section{Background}",
    "\\subsection*{Notation and $x_{i}$}",
    "\\subsubsection[short]{Long {nested} title}",
  ].join("\n")
  expect(buildOutline("main.tex", reader({ "main.tex": source }))).toEqual([
    { level: 0, command: "part", title: "Intro part", relPath: "main.tex", line: 2 },
    { level: 1, command: "chapter", title: "First", relPath: "main.tex", line: 3 },
    { level: 2, command: "section", title: "Background", relPath: "main.tex", line: 4 },
    {
      level: 3,
      command: "subsection*",
      title: "Notation and $x_{i}$",
      relPath: "main.tex",
      line: 5,
    },
    {
      level: 4,
      command: "subsubsection",
      title: "Long {nested} title",
      relPath: "main.tex",
      line: 6,
    },
  ])
})

test("commented lines and trailing comments are ignored, escaped percent is not a comment", () => {
  const source = [
    "% \\section{Hidden}",
    "\\section{Shown 50\\% done} % \\section{Also hidden}",
    "   %\\subsection{Indented hidden}",
  ].join("\n")
  expect(buildOutline("main.tex", reader({ "main.tex": source }))).toEqual([
    { level: 2, command: "section", title: "Shown 50\\% done", relPath: "main.tex", line: 2 },
  ])
})

test("follows input and include in document order, adding .tex and skipping cycles", () => {
  const files = {
    "main.tex": [
      "\\section{One}",
      "\\input{sections/intro}",
      "\\section{Three}",
      "\\include{appendix.tex}",
      "% \\input{sections/skipped}",
      "\\input{missing}",
    ].join("\n"),
    "sections/intro.tex": "\\subsection{Two}\n\\input{main}\n",
    "appendix.tex": "\n\\section{Four}\n",
    "sections/skipped.tex": "\\section{Never}\n",
  }
  expect(buildOutline("main.tex", reader(files))).toEqual([
    { level: 2, command: "section", title: "One", relPath: "main.tex", line: 1 },
    { level: 3, command: "subsection", title: "Two", relPath: "sections/intro.tex", line: 1 },
    { level: 2, command: "section", title: "Three", relPath: "main.tex", line: 3 },
    { level: 2, command: "section", title: "Four", relPath: "appendix.tex", line: 2 },
  ])
})

test("includes that leave the paper folder are not followed", () => {
  const files = {
    "main.tex": "\\input{../outside}\n\\input{/etc/x}\n",
    "../outside.tex": "\\section{X}",
  }
  expect(buildOutline("main.tex", reader(files))).toEqual([])
})
