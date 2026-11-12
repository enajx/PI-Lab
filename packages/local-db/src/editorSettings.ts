/**
 * Browser-safe built-in editor preferences. This module deliberately has no
 * database or Node imports so the renderer can consume the canonical defaults
 * without pulling the local-db migration/runtime barrel into its bundle.
 */
import type { ImportedEditorTheme } from "./editorThemeImport"

export type {
  ImportedEditorTheme,
  ImportedEditorThemeColors,
  ImportedEditorTokenColor,
} from "./editorThemeImport"

export type LatexProvider = "auto" | "bundled" | "system"

export type PythonRunDestination = "central" | "below-editor"

/**
 * File format of the research diary: Markdown (`diary.md`), Quarto Markdown
 * (`diary.qmd`), or MyST Markdown (`diary.md` with a MyST front matter).
 */
export type ResearchDiaryFormat = "md" | "qmd" | "myst"

/**
 * Format agents write analysis in: Markdown (`.md`), Quarto (`.qmd`), MyST
 * (`.md` with MyST front matter), HTML (`.html`), a marimo notebook (`.py`) or a
 * Jupyter notebook (`.ipynb`).
 */
export type AnalysisFormat = (typeof ANALYSIS_FORMATS)[number]

/** Every {@link AnalysisFormat}, in the order the Settings and Edit project choices list them. */
export const ANALYSIS_FORMATS = ["md", "qmd", "myst", "html", "marimo", "ipynb"] as const

/** Display names of the analysis formats. */
export const ANALYSIS_FORMAT_LABELS: Readonly<Record<AnalysisFormat, string>> = {
  md: "Markdown",
  qmd: "Quarto",
  myst: "MyST Markdown",
  html: "HTML",
  marimo: "marimo notebook",
  ipynb: "Jupyter notebook",
}

export interface EditorSettings {
  /** Save on debounce/blur instead of requiring an explicit ⌘S (default off). */
  autosave: boolean
  /** Enable the CodeMirror Vim keymap (default off). */
  vim: boolean
  /** Run Python type-checking and lint diagnostics in the editor (default off). */
  diagnosticsEnabled: boolean
  /** Which Python type checker the diagnostics run uses (default `ty`). */
  typeChecker: "ty" | "pyrefly"
  /** Run `ruff format` on ⌘S, then reload the buffer (default off). */
  formatOnSave: boolean
  /**
   * Stored id of the editor color theme. Kept a plain string so persistence
   * never couples to the renderer's theme registry.
   */
  editorTheme: string
  /** Parsed/copied custom themes; external source paths are never retained. */
  customEditorThemes: ImportedEditorTheme[]
  /** Default destination for Run Python; each run may override it. */
  pythonRunDestination: PythonRunDestination
  /** LaTeX compiler used for every project; "auto" uses system LaTeX when found, else bundled Tectonic. */
  latexProvider: LatexProvider
  /**
   * Default LaTeX build output folder, relative to the root .tex file's folder
   * ("." means next to the .tex). A paper can override it (default `build`).
   */
  latexOutputDir: string
  /** Show entries whose name starts with "." in the file tree (default on). */
  showHiddenFiles: boolean
  /** Ask before moving a file tree entry to the Trash (default on). */
  confirmFileDelete: boolean
  /** Ask before committing unsent paper edits when syncing with Overleaf (default on). */
  confirmOverleafCommit: boolean
  /**
   * Folder where papers added in the LaTeX Editor with no project go, one
   * folder per paper ("~" is the home folder; default `~/Papers`).
   */
  papersFolder: string
  /** Ask where to put such a paper, proposing a folder in {@link papersFolder} (default on). */
  askPapersFolder: boolean
  /** Research diary file format; switching renames the diary when its panel next opens (default `md`). */
  researchDiaryFormat: ResearchDiaryFormat
  /** Default format agents write analysis in; a project can override it (default `md`). */
  analysisFormat: AnalysisFormat
  /**
   * Folder name of the skill the Analysis view's Report button starts an agent
   * with, found in the project and user skills folders (default `experiment-report`).
   */
  reportSkill: string
}

/** Spec defaults for {@link EditorSettings}. */
export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  autosave: false,
  vim: false,
  diagnosticsEnabled: false,
  typeChecker: "ty",
  formatOnSave: false,
  editorTheme: "default",
  customEditorThemes: [],
  pythonRunDestination: "central",
  latexProvider: "auto",
  latexOutputDir: "build",
  showHiddenFiles: true,
  confirmFileDelete: true,
  confirmOverleafCommit: true,
  papersFolder: "~/Papers",
  askPapersFolder: true,
  researchDiaryFormat: "md",
  analysisFormat: "md",
  reportSkill: "experiment-report",
}
