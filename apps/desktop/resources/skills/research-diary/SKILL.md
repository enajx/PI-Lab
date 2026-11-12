---
name: research-diary
description: Add a short dated entry to the project's research diary about what was done today. Use when the user asks to update or write in the research diary.
---

# Research diary

This is a placeholder skill. It will be designed later.

1. Find the diary file: `md/research-diary/diary.md` in the project folder, or
   `md/research-diary/diary.qmd` when the project uses the Quarto format. A MyST diary is
   `diary.md` with a YAML front matter at the top; keep the front matter as it is.
2. Look for today's `## YYYY-MM-DD` heading (local date). Days are newest first, so it
   is near the top. If it is missing, add it at the top, below the front matter and the `# `
   title line if there are any.
3. Append a short entry under today's heading: what was done, what was found, and what
   comes next. Keep it short and plain; the diary is less polished than RESEARCH.md.
4. Do not change older entries.
5. Only days with an entry have a heading. Do not add a heading for a day with nothing
   under it; the app removes such headings when it saves the diary.
