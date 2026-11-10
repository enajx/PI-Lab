---
name: analyze-experiments
description: Summarise what the project's experiments show, from its results folder and EXPERIMENTS.md. Use when the user clicks Analyze experiments in PI Lab's Analysis view, or asks to analyze the project's experiments.
---

# Analyze experiments

This is a placeholder skill. It will be designed later.

1. Find the project's results folder. PI Lab may name it in the prompt. Otherwise use `results/`
   in the project. Each sub folder of the results folder is one experiment.
2. Read `EXPERIMENTS.md` in the project, if it exists, for what each experiment was meant to test.
3. For each experiment, read its files and summarise what it shows. Make plots where they help.
4. Tell the user the summary, and ask what they want to look at next.
