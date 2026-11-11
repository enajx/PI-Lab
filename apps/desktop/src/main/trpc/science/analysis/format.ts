import type { AnalysisFormat, EditorSettings, ProjectMetadata } from "@pi-lab/local-db"

/**
 * The analysis format for a project: its own choice from Edit project, else the
 * default from Settings. Agents are told to write analysis in this format.
 */
export function effectiveAnalysisFormat(
  metadata: ProjectMetadata | null,
  editor: EditorSettings,
): AnalysisFormat {
  return metadata?.analysisFormat ?? editor.analysisFormat
}

/** The sentence an agent's prompt gets for each analysis format. */
const ANALYSIS_FORMAT_INSTRUCTIONS: Readonly<Record<AnalysisFormat, string>> = {
  md: "Write the analysis as Markdown (.md).",
  qmd: "Write the analysis as Quarto (.qmd): Markdown with a YAML front matter and code cells.",
  myst: "Write the analysis as MyST Markdown (.md): start the file with a YAML front matter that has a `title:`.",
  html: "Write the analysis as an HTML page (.html) that works on its own, with its styles and images inside the file.",
  marimo:
    "Write the analysis as a marimo notebook (.py): a Python file with `import marimo`, `app = marimo.App()` and one `@app.cell` function per cell.",
  ipynb:
    "Write the analysis as a Jupyter notebook (.ipynb): nbformat 4 JSON, with the cell outputs saved in the file.",
}

/** The prompt sentence telling an agent which format to write analysis in. */
export function analysisFormatInstruction(format: AnalysisFormat): string {
  return ANALYSIS_FORMAT_INSTRUCTIONS[format]
}
