import { extensionOf } from "../Editor/utils/languageForPath"
import { QuickPythonEnvironmentPicker } from "./QuickPythonEnvironmentPicker"

type MarkdownMode = "render" | "source"

interface QuickEditorStatusBarProps {
  path: string
  line: number
  column: number
  vim: boolean
  onVimChange: (next: boolean) => void
  markdownMode: MarkdownMode
  onMarkdownModeChange: (next: MarkdownMode) => void
  pythonTargetId?: string
}

/** Show only editor-local controls that are ready with the quick buffer. */
export function QuickEditorStatusBar({
  path,
  line,
  column,
  vim,
  onVimChange,
  markdownMode,
  onMarkdownModeChange,
  pythonTargetId,
}: QuickEditorStatusBarProps) {
  const extension = extensionOf(path)
  const language = ["py", "pyi", "pyw"].includes(extension)
    ? "Python"
    : extension === "c"
      ? "C"
      : extension === "h"
        ? "C/C++"
        : ["cc", "hh", "cpp", "hpp", "cxx", "hxx"].includes(extension)
          ? "C++"
          : ["md", "markdown", "mdx"].includes(extension)
            ? "Markdown"
            : "Plain Text"
  const markdown = language === "Markdown"

  return (
    <footer
      data-testid="quick-editor-status-bar"
      className="flex h-6 shrink-0 items-center justify-end gap-3 border-border border-t bg-muted/30 px-3 text-[11px] text-muted-foreground"
    >
      <span data-testid="quick-editor-cursor">
        Ln {line}, Col {column}
      </span>
      <span data-testid="quick-editor-language">
        {pythonTargetId && language === "Python" ? (
          <QuickPythonEnvironmentPicker key={pythonTargetId} targetId={pythonTargetId} />
        ) : (
          language
        )}
      </span>
      {markdown ? (
        <fieldset
          aria-label="Markdown view"
          className="flex shrink-0 items-center rounded border border-border bg-background p-0.5"
        >
          <button
            type="button"
            aria-label="Render Markdown"
            aria-pressed={markdownMode === "render"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onMarkdownModeChange("render")}
            className={`rounded-sm px-1 ${markdownMode === "render" ? "bg-accent text-foreground" : "hover:bg-accent/60"}`}
          >
            Render
          </button>
          <button
            type="button"
            aria-label="Source Markdown"
            aria-pressed={markdownMode === "source"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onMarkdownModeChange("source")}
            className={`rounded-sm px-1 ${markdownMode === "source" ? "bg-accent text-foreground" : "hover:bg-accent/60"}`}
          >
            Source
          </button>
        </fieldset>
      ) : null}
      <button
        type="button"
        aria-label="Vim mode"
        aria-pressed={vim}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onVimChange(!vim)}
        className={`rounded px-1 ${vim ? "bg-accent text-foreground" : "hover:bg-accent/60"}`}
      >
        Vim
      </button>
    </footer>
  )
}
