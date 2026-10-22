# Midpoint integration paper

This example is a short LaTeX paper for testing PI Lab's Paper project type.
It includes a reproducible numerical calculation, a figure drawn from its
results, and a BibTeX citation. The work is pedagogical, not a research claim.

## Build and check

Requires a local TeX installation with `latexmk`, `pdflatex`, and TikZ. All
paper inputs are local. From this folder:

```sh
python3 analysis/midpoint.py
latexmk -pdf -interaction=nonstopmode -halt-on-error -outdir=build paper.tex
```

The compiled paper is `build/paper.pdf`. The script prints the values in the
results table. Edit `paper.tex` for the text, `figures/convergence.tex` for the
figure, and `references.bib` for citations.
