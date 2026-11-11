import type { AnalysisFormat, EditorSettings, ProjectMetadata } from "@pi-lab/local-db"

/**
 * The analysis format for a project: its own choice from Edit project, else the
 * default from Settings. Agents are told this format, and the `analysis-format` skill says how to write
 * each one.
 */
export function effectiveAnalysisFormat(
  metadata: ProjectMetadata | null,
  editor: EditorSettings,
): AnalysisFormat {
  return metadata?.analysisFormat ?? editor.analysisFormat
}
