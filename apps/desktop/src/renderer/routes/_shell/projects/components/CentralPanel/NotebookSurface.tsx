import { useMutation } from "@tanstack/react-query"
import { useTranslate } from "../../../../../i18n/language"
import { useTRPC } from "../../../../../trpc/react"
import type { NotebookPane } from "./useNotebookTabs"

/**
 * A notebook tab's content: the live marimo or Jupyter page from its local server,
 * with a bar naming the Python that runs it, Open in browser, and (for a PI Lab
 * copy in a uv project) a button that adds the tool to the project with `uv add`.
 */
export function NotebookSurface({
  pane,
  workspaceId,
}: {
  pane: NotebookPane
  workspaceId: string
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const openInBrowser = useMutation(trpc.notebooks.openInBrowser.mutationOptions())
  const addToProject = useMutation(trpc.notebooks.addToProject.mutationOptions())
  const toolName = pane.tool === "marimo" ? "marimo" : pane.tool === "jupyter" ? "Jupyter" : null

  if (pane.status === "starting") {
    return (
      <p data-testid="notebook-starting" className="p-4 text-muted-foreground text-sm">
        {t(
          "Starting the notebook server… The first start can take a few minutes while uv downloads marimo or JupyterLab.",
        )}
      </p>
    )
  }
  if (pane.status === "error") {
    return (
      <pre
        data-testid="notebook-error"
        className="cursor-text select-text whitespace-pre-wrap break-words p-4 font-mono text-destructive text-xs"
      >
        {pane.error}
      </pre>
    )
  }

  const addResult = addToProject.data
  const addError = addToProject.error?.message ?? openInBrowser.error?.message ?? null
  return (
    <div data-testid="notebook-surface" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-border border-b px-3 py-1.5 text-xs">
        <span
          data-testid="notebook-environment"
          className="min-w-0 flex-1 truncate text-muted-foreground"
        >
          {toolName}
          {pane.environmentLabel ? ` · ${pane.environmentLabel}` : ""}
        </span>
        {pane.canAddToProject && toolName ? (
          <button
            type="button"
            data-testid="notebook-add-to-project"
            disabled={addToProject.isPending}
            title={t(
              "Run `uv add --dev` in the project, so notebooks use the project's environment",
            )}
            onClick={() => addToProject.mutate({ workspaceId, tool: pane.tool ?? "jupyter" })}
            className="shrink-0 rounded-md border border-border px-2 py-1 disabled:opacity-50"
          >
            {pane.tool === "marimo"
              ? t("Add marimo to this project")
              : t("Add Jupyter to this project")}
          </button>
        ) : null}
        <button
          type="button"
          data-testid="notebook-open-browser"
          onClick={() => openInBrowser.mutate({ serverId: pane.id })}
          className="shrink-0 rounded-md border border-border px-2 py-1"
        >
          {t("Open in browser")}
        </button>
      </div>
      {addToProject.isPending ? (
        <p className="shrink-0 border-border border-b px-3 py-1.5 text-muted-foreground text-xs">
          {t("Running uv add…")}
        </p>
      ) : null}
      {addResult ? (
        <pre
          data-testid="notebook-add-output"
          data-ok={addResult.ok}
          className={`max-h-40 shrink-0 cursor-text select-text overflow-auto whitespace-pre-wrap border-border border-b px-3 py-1.5 font-mono text-xs ${addResult.ok ? "text-muted-foreground" : "text-destructive"}`}
        >
          {addResult.ok
            ? `${addResult.output}\n${t("Close and reopen the notebook to use the project's environment.")}`
            : addResult.output}
        </pre>
      ) : null}
      {addError ? (
        <p
          role="alert"
          className="shrink-0 cursor-text select-text px-3 py-1.5 text-destructive text-xs"
        >
          {addError}
        </p>
      ) : null}
      {pane.url ? (
        <iframe
          data-testid="notebook-frame"
          title={toolName ? `${toolName} notebook` : t("Notebook")}
          src={pane.url}
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups"
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      ) : null}
    </div>
  )
}
