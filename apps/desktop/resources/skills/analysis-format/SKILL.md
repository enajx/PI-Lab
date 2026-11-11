---
name: analysis-format
description: How to write an analysis in the format the user chose in PI Lab (md, qmd, myst, html, marimo or ipynb). Use when writing or revising an analysis file and PI Lab names an analysis format.
---

# Analysis format

This is a placeholder skill. It will be designed later.

PI Lab names the analysis format in the prompt, for example "The analysis format is qmd."
Write the analysis file as the section for that format below says. When the prompt names no
format, use `md`.

## md

Markdown (`.md`).

## qmd

Quarto (`.qmd`): Markdown with a YAML front matter and code cells.

## myst

MyST Markdown (`.md`): start the file with a YAML front matter that has a `title:`.

## html

An HTML page (`.html`) that works on its own, with its styles and images inside the file.

## marimo

A marimo notebook (`.py`): a Python file with `import marimo`, `app = marimo.App()` and one
`@app.cell` function per cell.

## ipynb

A Jupyter notebook (`.ipynb`): nbformat 4 JSON, with the cell outputs saved in the file.
