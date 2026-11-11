import { splitFrontMatter } from "@pi-lab/shared/markdown/front-matter"
import { Button } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ReactNode } from "react"
import type { DocumentTool } from "../../../main/documents/tools"
import { useTranslate } from "../../i18n/language"
import { useTRPC } from "../../trpc/react"

/**
 * Render controls for Quarto (.qmd) and MyST (.md) files, used by the Analysis
 * preview and the research diary panel. {@link RenderControl} is the Render
 * button, or an Install button with progress when the tool is missing.
 * {@link RenderedDocument} shows a render's result: the page (passed as
 * children), Open in browser, and the build log, which is open when the
 * render failed.
 */

/** The result of `documents.render`. */
export interface DocumentRenderResult {
  tool: DocumentTool
  ok: boolean
  log: string
  outputRelPath: string | null
}

export const DOCUMENT_TOOL_NAMES: Readonly<Record<DocumentTool, string>> = {
  quarto: "Quarto",
  myst: "MyST",
}

/**
 * The tool that renders a file in Analysis: Quarto for a .qmd, MyST for a .md
 * whose text starts with a YAML front matter (how PI Lab marks a MyST file),
 * else null (no Render button). `text` is the file's text, or null when not loaded.
 */
export function documentToolForFile(relPath: string, text: string | null): DocumentTool | null {
  const lower = relPath.toLowerCase()
  if (lower.endsWith(".qmd")) return "quarto"
  if (lower.endsWith(".md") && text !== null && splitFrontMatter(text).frontMatter !== null)
    return "myst"
  return null
}

const SETTLED_STATES = ["idle", "complete", "failed"]

/** `documents.tools`, polled while an install runs. */
export function useDocumentTools() {
  const trpc = useTRPC()
  return useQuery(
    trpc.documents.tools.queryOptions(undefined, {
      refetchInterval: (query) => {
        const installation = query.state.data?.installation
        if (!installation) return false
        const running = Object.values(installation).some(
          (status) => !SETTLED_STATES.includes(status.state),
        )
        return running ? 500 : false
      },
    }),
  )
}

/** The Install button for one tool, with its progress and error. */
export function InstallToolButton({ tool }: { tool: DocumentTool }) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const status = useDocumentTools()
  const install = useMutation(
    trpc.documents.install.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.documents.tools.queryKey() }),
    }),
  )
  const installation = status.data?.installation[tool]
  const installing = Boolean(installation && !SETTLED_STATES.includes(installation.state))
  const name = DOCUMENT_TOOL_NAMES[tool]
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-6 px-2 text-xs"
        data-testid={`document-install-${tool}`}
        disabled={install.isPending || installing}
        onClick={() => install.mutate({ tool })}
      >
        {`${t("Install")} ${name}`}
      </Button>
      {installation?.message ? (
        <span role="status" className="min-w-0 truncate text-muted-foreground">
          {installation.message}
        </span>
      ) : null}
      {installing ? (
        <progress
          className="w-20"
          aria-label={`${name} ${t("installation")}`}
          max={100}
          value={installation?.progress ?? undefined}
        />
      ) : null}
      {installation?.error || install.error ? (
        <span role="alert" className="min-w-0 cursor-text select-text text-destructive">
          {installation?.error ?? install.error?.message}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Render button for one file. While the tools are checked it shows nothing;
 * when the tool is missing it shows {@link InstallToolButton}. A render call
 * that fails is passed on as a failed result, so its message is shown.
 */
export function RenderControl({
  projectId,
  relPath,
  tool,
  onRendered,
}: {
  projectId: string
  relPath: string
  tool: DocumentTool
  onRendered: (result: DocumentRenderResult) => void
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const status = useDocumentTools()
  const render = useMutation(trpc.documents.render.mutationOptions())
  if (status.error) {
    return (
      <span role="alert" className="text-destructive text-xs">
        {status.error.message}
      </span>
    )
  }
  if (!status.data) return null
  if (!status.data[tool]) return <InstallToolButton tool={tool} />
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-6 shrink-0 px-2 text-xs"
      data-testid="document-render"
      disabled={render.isPending}
      data-feature-help={t("Render this file to HTML; code blocks run")}
      onClick={() =>
        render.mutate(
          { projectId, relPath },
          {
            onSuccess: (result) => onRendered(result),
            onError: (error) =>
              onRendered({ tool, ok: false, log: error.message, outputRelPath: null }),
          },
        )
      }
    >
      {render.isPending ? t("Rendering…") : t("Render")}
    </Button>
  )
}

/** A render's result: the rendered page (children) with Open in browser, or the failure, and the build log. */
export function RenderedDocument({
  projectId,
  result,
  onClose,
  children,
}: {
  projectId: string
  result: DocumentRenderResult
  onClose: () => void
  children: ReactNode
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const openInBrowser = useMutation(trpc.documents.openInBrowser.mutationOptions())
  const outputRelPath = result.ok ? result.outputRelPath : null
  return (
    <div data-testid="document-rendered" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-border border-b px-3 py-1.5 text-xs">
        {outputRelPath ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={outputRelPath}>
            {`${t("Rendered with")} ${DOCUMENT_TOOL_NAMES[result.tool]}`}
          </span>
        ) : (
          <span role="alert" className="min-w-0 flex-1 text-destructive">
            {t("Render failed. See the build log.")}
          </span>
        )}
        {outputRelPath ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            data-testid="document-open-in-browser"
            onClick={() => openInBrowser.mutate({ projectId, relPath: outputRelPath })}
          >
            {t("Open in browser")}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          data-testid="document-show-source"
          onClick={onClose}
        >
          {t("Show source")}
        </Button>
      </div>
      {openInBrowser.error ? (
        <p role="alert" className="shrink-0 px-3 py-1 text-destructive text-xs">
          {openInBrowser.error.message}
        </p>
      ) : null}
      <details open={!outputRelPath} className="shrink-0 border-border border-b px-3 py-1 text-xs">
        <summary className="cursor-pointer text-muted-foreground">{t("Build log")}</summary>
        <pre
          data-testid="document-render-log"
          className="max-h-64 cursor-text select-text overflow-auto whitespace-pre-wrap break-words py-1 font-mono"
        >
          {result.log}
        </pre>
      </details>
      {outputRelPath ? <div className="min-h-0 flex-1">{children}</div> : null}
    </div>
  )
}
