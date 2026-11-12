import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { splitFrontMatter } from "@pi-lab/shared/markdown/front-matter"
import { useMutation, useQuery } from "@tanstack/react-query"
import { type ReactNode, useEffect, useRef, useState } from "react"
import type { DiaryFile } from "../../../main/trpc/diary/diary"
import { CodeMirrorBuffer } from "../../Editor/components/CodeMirrorBuffer"
import { MarkdownModeToggle } from "../../Editor/components/MarkdownModeToggle"
import { translateKnownError } from "../../i18n/errors"
import { useInterfaceLanguage, useTranslate } from "../../i18n/language"
import { Markdown } from "../../routes/_shell/projects/components/RightSidebar/components/Markdown"
import { InteractivePreview } from "../../routes/_shell/science/components/ScienceAnalysis/components/AnalysisPreview/AnalysisPreview"
import { useTRPC } from "../../trpc/react"
import {
  type DocumentRenderResult,
  RenderControl,
  RenderedDocument,
} from "../DocumentRender/DocumentRender"

/**
 * Research diary panel: a tab of the project view's right sidebar, and the lower
 * part of the Analysis and Tasks right panel (the whole right column in the LaTeX
 * Editor). It fills its container. On mount (and on a project change) it calls
 * `diary.open`, which returns the diary with today's `## YYYY-MM-DD` heading at
 * the top (not yet on disk). The diary is edited in place: the header's
 * Markdown view switch (the same one Markdown files use in the editor) picks
 * Render, the editor's editable rendered Markdown, or Source, the plain text.
 * A Quarto diary (diary.qmd) is not Markdown to the editor, so its Render view
 * is the rendered Markdown (front matter hidden), and a click on it switches
 * to Source. A dot next to the title marks unsaved changes; ⌘S writes the
 * text through `diary.save`, which drops the day headings with nothing under
 * them. A save refused because the file changed on disk shows the error and
 * keeps the edit. A Quarto diary, or the diary in MyST mode, also gets a Render
 * button that renders the saved file with quarto or mystmd and shows the HTML
 * page in the panel, until Show source. `headerActions` go at the end of its
 * header (e.g. a collapse button), or null for none.
 */
export function ResearchDiaryPanel({
  projectId,
  headerActions,
}: {
  projectId: string
  headerActions: ReactNode
}) {
  const t = useTranslate()
  const [language] = useInterfaceLanguage()
  const trpc = useTRPC()
  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const editorSettings = settingsQuery.data?.editor ?? DEFAULT_EDITOR_SETTINGS

  const openDiary = useMutation(trpc.diary.open.mutationOptions())
  const openDiaryRef = useRef(openDiary.mutateAsync)
  openDiaryRef.current = openDiary.mutateAsync
  const saveDiary = useMutation(trpc.diary.save.mutationOptions())
  // The diary as opened, with `content` updated to the text of each successful save.
  const [loaded, setLoaded] = useState<DiaryFile | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  // The text in the editor; it differs from `loaded.content` while there are unsaved changes.
  const [draft, setDraft] = useState("")
  const [mode, setMode] = useState<"render" | "source">("render")
  // The last render of the diary, shown instead of the editor until Show source.
  const [rendered, setRendered] = useState<{ result: DocumentRenderResult; at: number } | null>(
    null,
  )
  const quarto = loaded?.relPath.endsWith(".qmd") ?? false
  const renderTool = !loaded
    ? null
    : quarto
      ? "quarto"
      : editorSettings.researchDiaryFormat === "myst"
        ? "myst"
        : null
  const dirty = loaded !== null && draft !== loaded.content

  useEffect(() => {
    // Only the still-active run applies its result (StrictMode runs effects twice;
    // `diary.open` writes nothing).
    let active = true
    setLoaded(null)
    setOpenError(null)
    setDraft("")
    setMode("render")
    setRendered(null)
    openDiaryRef.current({ projectId }).then(
      (file) => {
        if (!active) return
        setLoaded(file)
        setDraft(file.content)
      },
      (error: Error) => {
        if (active) setOpenError(error.message)
      },
    )
    return () => {
      active = false
    }
  }, [projectId])

  const save = () => {
    if (!loaded || saveDiary.isPending) return
    const content = draft
    saveDiary.mutate(
      { projectId, relPath: loaded.relPath, content, baseline: loaded.baseline },
      { onSuccess: (result) => setLoaded({ ...loaded, content, baseline: result.baseline }) },
    )
  }

  const changeMode = (next: "render" | "source") => {
    setRendered(null)
    setMode(next)
  }

  return (
    <section
      data-testid="research-diary-panel"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-border border-b px-2">
        <span
          className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs"
          title={loaded?.relPath ?? undefined}
        >
          <span className="truncate">{t("Research diary")}</span>
          {dirty ? (
            <span
              data-testid="research-diary-dirty"
              title={t("Unsaved changes")}
              className="size-1.5 shrink-0 rounded-full bg-foreground/60"
            />
          ) : null}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {loaded && renderTool ? (
            <RenderControl
              projectId={projectId}
              relPath={loaded.relPath}
              tool={renderTool}
              onRendered={(result) => setRendered({ result, at: Date.now() })}
            />
          ) : null}
          {loaded ? <MarkdownModeToggle mode={mode} onChange={changeMode} /> : null}
          {headerActions}
        </div>
      </div>
      {saveDiary.error ? (
        <p
          role="alert"
          data-testid="research-diary-save-error"
          className="shrink-0 cursor-text select-text border-border border-b px-3 py-2 text-destructive text-xs"
        >
          {translateKnownError(language, saveDiary.error.message)}
        </p>
      ) : null}
      {openError ? (
        <p
          role="alert"
          data-testid="research-diary-error"
          className="cursor-text select-text px-3 py-2 text-destructive text-xs"
        >
          {translateKnownError(language, openError)}
        </p>
      ) : !loaded ? (
        <p className="px-3 py-2 text-muted-foreground text-xs">{t("Loading…")}</p>
      ) : rendered ? (
        <div className="min-h-0 flex-1">
          <RenderedDocument
            projectId={projectId}
            result={rendered.result}
            onClose={() => setRendered(null)}
          >
            {rendered.result.outputRelPath ? (
              <InteractivePreview
                key={rendered.at}
                projectId={projectId}
                relPath={rendered.result.outputRelPath}
                kind="report"
              />
            ) : null}
          </RenderedDocument>
        </div>
      ) : quarto && mode === "render" ? (
        // The Source switch in the header is the keyboard way to the same view.
        // biome-ignore lint/a11y/noStaticElementInteractions: a click on the text is a shortcut to Source.
        // biome-ignore lint/a11y/useKeyWithClickEvents: the header's Source switch does this from the keyboard.
        <div
          data-testid="research-diary-rendered"
          className="min-h-0 flex-1 cursor-text overflow-y-auto px-4 py-3"
          onClick={() => setMode("source")}
        >
          <Markdown content={splitFrontMatter(draft).body} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <CodeMirrorBuffer
            autoFocus={quarto}
            relPath={loaded.relPath}
            initialDoc={draft}
            onChange={setDraft}
            onSave={save}
            markdownMode={quarto ? undefined : mode}
            vim={editorSettings.vim}
            theme={editorSettings.editorTheme}
            customThemes={editorSettings.customEditorThemes}
          />
        </div>
      )}
    </section>
  )
}
