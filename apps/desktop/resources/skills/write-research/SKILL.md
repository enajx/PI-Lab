---
name: write-research
description: Write or update the project's LaTeX paper from its research and recent experiment results. Use when the user clicks Update paper in PI Lab's LaTeX Editor, or asks to write or update the paper.
---

# Write research

This is a placeholder skill. It will be designed later.

1. Find the paper folder and its main .tex file. PI Lab gives both in the prompt when it starts
   you from the LaTeX Editor. Otherwise look for a `paper/` folder or a .tex file with
   `\documentclass` in the project.
2. Read the main .tex file and the files it includes.
3. If the paper is blank (it holds only the template text):
   - Ask the user about the scientific question, the contributions, and the target venue.
   - Check the recent experiment results in the project.
   - Write a bullet-point outline of the paper's sections into the .tex file.
4. Otherwise:
   - Check the recent experiment results and runs in the project.
   - Update the paper's results, figures, and text from them.
   - Ask the user before any large change.
5. Tell the user what you changed.
