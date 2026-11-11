/**
 * Small reader for Jupyter notebooks (`.ipynb`, nbformat 4) for the Analysis
 * preview. Pure: it takes the file text and returns the cells with their stored
 * outputs. Outputs it can show are text (streams, `text/plain`, errors as
 * `name: value`) and `image/png` images; any other output is kept as
 * "unsupported" so the preview can say it is not shown.
 */

/** One stored output of a code cell. */
export type NotebookOutput =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string }
  | { type: "unsupported"; outputType: string }

/** One notebook cell: its kind, its source text, and (for code cells) its outputs. */
export interface NotebookCell {
  type: "markdown" | "code" | "raw"
  source: string
  outputs: NotebookOutput[]
}

/** A parsed notebook. */
export interface ParsedNotebook {
  cells: NotebookCell[]
}

/** nbformat stores multi-line strings as a string or a list of lines. */
function joinText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value) && value.every((line) => typeof line === "string")) {
    return value.join("")
  }
  return ""
}

function parseOutput(raw: Record<string, unknown>): NotebookOutput {
  const outputType = typeof raw.output_type === "string" ? raw.output_type : "unknown"
  if (outputType === "stream") return { type: "text", text: joinText(raw.text) }
  if (outputType === "error") {
    return { type: "text", text: `${String(raw.ename)}: ${String(raw.evalue)}` }
  }
  if (outputType === "execute_result" || outputType === "display_data") {
    const data = (raw.data ?? {}) as Record<string, unknown>
    const png = joinText(data["image/png"]).replace(/\s/g, "")
    if (png !== "") return { type: "image", dataUrl: `data:image/png;base64,${png}` }
    if (data["text/plain"] !== undefined) {
      return { type: "text", text: joinText(data["text/plain"]) }
    }
  }
  return { type: "unsupported", outputType }
}

/** Parse notebook JSON text. Throws when the text is not JSON or not a notebook. */
export function parseIpynb(text: string): ParsedNotebook {
  const parsed: unknown = JSON.parse(text)
  const cells = (parsed as { cells?: unknown } | null)?.cells
  if (!Array.isArray(cells)) {
    throw new Error("This file is not a Jupyter notebook: it has no list of cells.")
  }
  return {
    cells: cells.map((value): NotebookCell => {
      const cell = value as Record<string, unknown>
      const type =
        cell.cell_type === "markdown" || cell.cell_type === "code" ? cell.cell_type : "raw"
      const outputs = Array.isArray(cell.outputs)
        ? cell.outputs.map((output) => parseOutput(output as Record<string, unknown>))
        : []
      return { type, source: joinText(cell.source), outputs }
    }),
  }
}
