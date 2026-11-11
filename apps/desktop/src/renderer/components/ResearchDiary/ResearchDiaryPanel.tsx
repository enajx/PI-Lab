import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { splitFrontMatter } from "@pi-lab/shared/markdown/front-matter"
import { Button } from "@pi-lab/ui"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import type { DiaryFile } from "../../../main/trpc/diary/diary"
import { CodeMirrorBuffer } from "../../Editor/components/CodeMirrorBuffer"
import { translateKnownError } from "../../i18n/errors"
import { useInterfaceLanguage, useTranslate } from "../../i18n/language"
import {
  RESEARCH_DIARY_MAX_WIDTH,
  RESEARCH_DIARY_MIN_WIDTH,
  useResearchDiaryWidth,
} from "../../preferences/preferences"
import { Markdown } from "../../routes/_shell/projects/components/RightSidebar/components/Markdown"
import { InteractivePreview } from "../../routes/_shell/science/components/ScienceAnalysis/components/AnalysisPreview/AnalysisPreview"
import { useTRPC } from "../../trpc/react"
import {
  type DocumentRenderResult,
  RenderControl,
  RenderedDocument,
} from "../DocumentRender/DocumentRender"
import { EdgeResizeHandle } from "../EdgeResizeHandle"

/**
 * Research diary panel, shown on the right of the project view and the Analysis
 * view. On mount (and on a project change) it calls `diary.open`, which creates
 * the diary file and today's `## YYYY-MM-DD` heading when needed, and shows the
 * diary rendered as Markdown (a leading YAML front matter is not shown). A
 * Quarto diary (diary.qmd), or the diary in MyST mode, also gets a Render button
 * that renders it with quarto or mystmd and shows the HTML page in the panel,
 * until Show source. Edit switches to the Markdown source editor; Save
 * (or ⌘S) writes the file through `diary.save` and goes back to the rendered
 * view. A save refused because the file changed on disk shows the error and
 * keeps the edit open. The panel is resizable from its left edge; the width is
 * a saved preference.
 */
export function ResearchDiaryPanel({ projectId }: { projectId: string }) {
  const t = useTranslate()
  const [language] = useInterfaceLanguage()
  const trpc = useTRPC()
  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const editorSettings = settingsQuery.data?.editor ?? DEFAULT_EDITOR_SETTINGS
  const [savedWidth, persistWidth] = useResearchDiaryWidth()
  const [width, setWidth] = useState(savedWidth)
  useEffect(() => setWidth(savedWidth), [savedWidth])

  const openDiary = useMutation(trpc.diary.open.mutationOptions())
  const openDiaryRef = useRef(openDiary.mutateAsync)
  openDiaryRef.current = openDiary.mutateAsync
  const saveDiary = useMutation(trpc.diary.save.mutationOptions())
  const [loaded, setLoaded] = useState<DiaryFile | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  // The Markdown source being edited, or null while the rendered view is shown.
  const [draft, setDraft] = useState<string | null>(null)
  // The last render of the diary, shown instead of the Markdown view until Show source.
  const [rendered, setRendered] = useState<{ result: DocumentRenderResult; at: number } | null>(
    null,
  )
  const renderTool = !loaded
    ? null
    : loaded.relPath.endsWith(".qmd")
      ? "quarto"
      : editorSettings.researchDiaryFormat === "myst"
        ? "myst"
        : null

  useEffect(() => {
    // Only the still-active run applies its result (StrictMode runs effects twice;
    // `diary.open` is idempotent).
    let active = true
    setLoaded(null)
    setOpenError(null)
    setDraft(null)
    setRendered(null)
    openDiaryRef.current({ projectId }).then(
      (file) => {
        if (active) setLoaded(file)
      },
      (error: Error) => {
        if (active) setOpenError(error.message)
      },
    )
    return () => {
      active = false
    }
  }, [projectId])

  const startEdit = () => {
    if (!loaded) return
    saveDiary.reset()
    setRendered(null)
    setDraft(loaded.content)
  }

  const save = () => {
    if (!loaded || draft === null || saveDiary.isPending) return
    const content = draft
    saveDiary.mutate(
      { projectId, relPath: loaded.relPath, content, baseline: loaded.baseline },
      {
        onSuccess: (result) => {
          setLoaded({ ...loaded, content, baseline: result.baseline })
          setDraft(null)
        },
      },
    )
  }

  return (
    <aside
      data-testid="research-diary-panel"
      className="relative flex min-h-0 shrink-0 flex-col overflow-hidden rounded-lg border border-border"
      style={{ width }}
    >
      <EdgeResizeHandle
        side="left"
        width={width}
        onResize={setWidth}
        onResizeEnd={persistWidth}
        min={RESEARCH_DIARY_MIN_WIDTH}
        max={RESEARCH_DIARY_MAX_WIDTH}
        testId="research-diary-edge-drag"
      />
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-border border-b px-2">
        <span
          className="min-w-0 truncate text-muted-foreground text-xs"
          title={loaded?.relPath ?? undefined}
        >
          {t("Research diary")}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {draft === null && loaded && renderTool ? (
            <RenderControl
              projectId={projectId}
              relPath={loaded.relPath}
              tool={renderTool}
              onRendered={(result) => setRendered({ result, at: Date.now() })}
            />
          ) : null}
          {draft === null ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="research-diary-edit"
              className="h-6 px-2 text-xs"
              disabled={!loaded}
              data-feature-help={t("Edit the diary's Markdown source")}
              onClick={startEdit}
            >
              {t("Edit")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="research-diary-save"
              className="h-6 px-2 text-xs"
              disabled={saveDiary.isPending}
              data-feature-help={t("Save the diary and show it rendered")}
              onClick={save}
            >
              {t("Save")}
            </Button>
          )}
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
      ) : draft !== null ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <CodeMirrorBuffer
            autoFocus
            relPath={loaded.relPath}
            initialDoc={draft}
            onChange={setDraft}
            onSave={save}
            vim={editorSettings.vim}
            theme={editorSettings.editorTheme}
            customThemes={editorSettings.customEditorThemes}
          />
        </div>
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
      ) : (
        <div
          data-testid="research-diary-rendered"
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        >
          <Markdown content={splitFrontMatter(loaded.content).body} />
        </div>
      )}
    </aside>
  )
}
