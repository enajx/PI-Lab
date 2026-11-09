import type { EditorSettings } from "@pi-lab/local-db/editor-settings"
import { cn } from "@pi-lab/ui"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslate } from "../../../../../i18n/language"
import { useTRPC, useTRPCClient } from "../../../../../trpc/react"
import { CentralPanel, useCentralPanel } from "../../../projects/components/CentralPanel"
import { PaperSyncBar } from "./PaperSyncBar"

interface PaperEditorProps {
  projectId: string
  projectName: string
  /** The paper folder's workspace (kind "paper"). */
  workspaceId: string
  /** The main .tex file, relative to the paper folder, or null when none was found. */
  rootRelPath: string | null
  lastSyncAt: number | null
  hasRemote: boolean
  settings: EditorSettings
  onUpdateEditorSettings: (patch: Partial<EditorSettings>) => void
}

/** The PDF a root `.tex` builds to: `<root dir>/build/<root name>.pdf`. */
function pdfFor(rootRelPath: string): string {
  const slash = rootRelPath.lastIndexOf("/")
  const dir = slash < 0 ? "" : rootRelPath.slice(0, slash + 1)
  const name = rootRelPath.slice(slash + 1).replace(/\.tex$/i, "")
  return `${dir}build/${name}.pdf`
}

/**
 * The LaTeX Editor workspace for a linked paper: an outline and file list on
 * the left, and the editor panel (source and PDF side by side, with build,
 * build log and SyncTeX) with the Sync bar below it.
 */
export function PaperEditor({
  projectId,
  projectName,
  workspaceId,
  rootRelPath,
  lastSyncAt,
  hasRemote,
  settings,
  onUpdateEditorSettings,
}: PaperEditorProps) {
  const t = useTranslate()
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const outline = useQuery(trpc.paper.outline.queryOptions({ projectId }))
  const files = useQuery(trpc.paper.files.queryOptions({ projectId }))
  const onSaved = useCallback(
    (relPath: string): void => {
      if (!/\.(tex|bib)$/i.test(relPath)) return
      void queryClient.invalidateQueries({ queryKey: trpc.paper.outline.queryKey({ projectId }) })
      void queryClient.invalidateQueries({ queryKey: trpc.paper.files.queryKey({ projectId }) })
    },
    [projectId, queryClient, trpc],
  )
  const controller = useCentralPanel({ client, workspaceId, projectId, settings, onSaved })
  const [sourceRequest, setSourceRequest] = useState<{
    relPath: string
    line: number
    column: number
    nonce: number
  } | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)

  // Open the main .tex and, when it was built before, its PDF beside it, once per paper.
  const openedFor = useRef<string | null>(null)
  const openFile = controller.openFile
  useEffect(() => {
    if (!rootRelPath || openedFor.current === workspaceId) return
    openedFor.current = workspaceId
    openFile(rootRelPath)
    const pdf = pdfFor(rootRelPath)
    client.files.stat.query({ workspaceId, relPath: pdf }).then(
      (stat) => {
        if (stat.exists) openFile(pdf)
      },
      (cause: unknown) => setOpenError(`${pdf}: ${String(cause)}`),
    )
  }, [client, openFile, rootRelPath, workspaceId])

  return (
    <div data-testid="paper-editor" className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-border border-r text-xs">
          <h2 className="px-3 pt-3 pb-1 font-medium text-muted-foreground">{t("Outline")}</h2>
          {outline.isError ? (
            <p role="alert" className="px-3 text-destructive">
              {outline.error.message}
            </p>
          ) : outline.data?.length === 0 ? (
            <p className="px-3 text-muted-foreground">{t("No sections")}</p>
          ) : (
            <ul data-testid="paper-outline">
              {outline.data?.map((entry) => (
                <li key={`${entry.relPath}:${entry.line}`}>
                  <button
                    type="button"
                    data-testid="paper-outline-entry"
                    title={`${entry.relPath}:${entry.line}`}
                    className="w-full truncate py-1 pr-2 text-left hover:bg-accent"
                    style={{ paddingLeft: `${12 + Math.max(0, entry.level - 2) * 10}px` }}
                    onClick={() =>
                      setSourceRequest({
                        relPath: entry.relPath,
                        line: entry.line,
                        column: 1,
                        nonce: Date.now(),
                      })
                    }
                  >
                    {entry.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h2 className="px-3 pt-4 pb-1 font-medium text-muted-foreground">{t("Files")}</h2>
          {files.isError ? (
            <p role="alert" className="px-3 text-destructive">
              {files.error.message}
            </p>
          ) : (
            <ul data-testid="paper-files">
              {files.data?.map((file) => (
                <li key={file.relPath}>
                  <button
                    type="button"
                    data-testid="paper-file"
                    data-kind={file.kind}
                    className={cn(
                      "w-full truncate px-3 py-1 text-left font-mono hover:bg-accent",
                      file.kind === "figure" && "text-muted-foreground",
                    )}
                    title={file.relPath}
                    onClick={() => controller.openFile(file.relPath)}
                  >
                    {file.relPath}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {openError ? (
            <p role="alert" className="cursor-text select-text px-3 py-1 text-destructive text-xs">
              {openError}
            </p>
          ) : null}
          <CentralPanel
            controller={controller}
            client={client}
            workspaceId={workspaceId}
            openFileFinder={false}
            onFileFinderOpened={() => undefined}
            projectName={projectName}
            settings={settings}
            onUpdateEditorSettings={onUpdateEditorSettings}
            rightSidebarCollapsed={false}
            onExpandRightSidebar={() => undefined}
            filesPanelOpen={false}
            onFilesPanelOpenChange={() => undefined}
            pdfBesideSource={true}
            sourceRequest={sourceRequest}
          />
        </div>
      </div>
      <PaperSyncBar
        projectId={projectId}
        workspaceId={workspaceId}
        lastSyncAt={lastSyncAt}
        hasRemote={hasRemote}
        confirmCommit={settings.confirmOverleafCommit}
        saveOpenFiles={async () => {
          const failed: string[] = []
          for (const tab of controller.editor.tabs) {
            if (tab.dirty && !(await controller.editor.saveFile(tab.relPath)))
              failed.push(tab.relPath)
          }
          return failed
        }}
        onOpenFiles={(paths) => {
          for (const relPath of paths) controller.openFile(relPath)
        }}
      />
    </div>
  )
}
