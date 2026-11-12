import { CodeXml, Eye } from "lucide-react"
import { useTranslate } from "../../../i18n/language"

/**
 * The Markdown view switch: Render (the formatted Markdown, still editable) or
 * Source (the plain text). Used by the editor status bar and the research diary.
 */
export function MarkdownModeToggle({
  mode,
  onChange,
}: {
  mode: "render" | "source"
  onChange: (mode: "render" | "source") => void
}) {
  const t = useTranslate()
  return (
    <fieldset
      data-testid="markdown-mode-toggle"
      aria-label={t("Markdown view")}
      className="flex shrink-0 items-center rounded border border-border bg-background p-0.5"
    >
      <button
        type="button"
        aria-label={t("Render Markdown")}
        data-feature-help={t("Show the Markdown with its formatting applied.")}
        aria-pressed={mode === "render"}
        onClick={() => onChange("render")}
        className={
          mode === "render"
            ? "flex size-4 items-center justify-center rounded-sm bg-accent text-foreground"
            : "flex size-4 items-center justify-center rounded-sm hover:bg-accent/60"
        }
      >
        <Eye className="size-3" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={t("Source Markdown")}
        data-feature-help={t("Show the plain Markdown text for editing.")}
        aria-pressed={mode === "source"}
        onClick={() => onChange("source")}
        className={
          mode === "source"
            ? "flex size-4 items-center justify-center rounded-sm bg-accent text-foreground"
            : "flex size-4 items-center justify-center rounded-sm hover:bg-accent/60"
        }
      >
        <CodeXml className="size-3" aria-hidden />
      </button>
    </fieldset>
  )
}
