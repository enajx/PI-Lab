import type { AddPanelPositionOptions } from "dockview-react"

/**
 * Split placement for the LaTeX Editor layout: a PDF tab opens to the right of
 * the open LaTeX source, and later PDFs join the split of the PDF already open.
 * Returns undefined (default placement) for every other tab.
 *
 * @param id the dock item id being added (`file:<relPath>` for files)
 * @param openRelPaths the relative paths of the file tabs already open
 */
export function pdfBesideSource(
  id: string,
  openRelPaths: string[],
): AddPanelPositionOptions | undefined {
  if (!id.startsWith("file:") || !/\.pdf$/i.test(id)) return undefined
  const adding = id.slice("file:".length)
  const openPdf = openRelPaths.find((relPath) => relPath !== adding && /\.pdf$/i.test(relPath))
  if (openPdf) return { referencePanel: `file:${openPdf}`, direction: "within" }
  const source = openRelPaths.find((relPath) => /\.tex$/i.test(relPath))
  if (source) return { referencePanel: `file:${source}`, direction: "right" }
  return undefined
}
