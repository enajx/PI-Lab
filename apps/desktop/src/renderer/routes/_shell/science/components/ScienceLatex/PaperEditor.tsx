import type { EditorSettings } from "@pi-lab/local-db/editor-settings"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslate } from "../../../../../i18n/language"
import {
  useLatexEditorFilesOpen,
  useLatexEditorLeftColumn,
  useLatexEditorOutlineOpen,
} from "../../../../../preferences/preferences"
import { useTRPC, useTRPCClient } from "../../../../../trpc/react"
import {
  CentralPanel,
  type CentralPanelController,
  useCentralPanel,
} from "../../../projects/components/CentralPanel"
import { CollapsibleSection } from "../../../projects/components/CentralPanel/CollapsibleSection"
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
  /** This paper's own build output folder, or null when it uses the global default. */
  outputDir: string | null
  /** The build output folder its builds use. */
  effectiveOutputDir: string
  settings: EditorSettings
  onUpdateEditorSettings: (patch: Partial<EditorSettings>) => void
}

/**
 * The PDF a root `.tex` builds to: `<root dir>/<output folder>/<root name>.pdf`
 * ("." puts it next to the .tex).
 */
function pdfFor(rootRelPath: string, outputDir: string): string {
  const slash = rootRelPath.lastIndexOf("/")
  const dir = slash < 0 ? "" : rootRelPath.slice(0, slash + 1)
  const name = rootRelPath.slice(slash + 1).replace(/\.tex$/i, "")
  return outputDir === "." ? `${dir}${name}.pdf` : `${dir}${outputDir}/${name}.pdf`
}

/**
 * The LaTeX Editor workspace for a linked paper: the editor panel (source and
 * PDF side by side, with build, build log and SyncTeX) whose left column holds
 * the outline above the paper folder's file tree, with the Sync bar below.
 * Saving a .tex builds it and opens the built PDF beside the source when it is
 * not open yet (an open PDF reloads itself when the file changes).
 */
export function PaperEditor({
  projectId,
  projectName,
  workspaceId,
  rootRelPath,
  lastSyncAt,
  hasRemote,
  outputDir,
  effectiveOutputDir,
  settings,
  onUpdateEditorSettings,
}: PaperEditorProps) {
  const t = useTranslate()
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const outline = useQuery(trpc.paper.outline.queryOptions({ projectId }))
  const [leftColumnOpen, setLeftColumnOpen] = useLatexEditorLeftColumn()
  const [outlineOpen, setOutlineOpen] = useLatexEditorOutlineOpen()
  const [filesOpen, setFilesOpen] = useLatexEditorFilesOpen()
  const [openError, setOpenError] = useState<string | null>(null)
  const onSaved = useCallback(
    (relPath: string): void => {
      if (!/\.(tex|bib)$/i.test(relPath)) return
      void queryClient.invalidateQueries({ queryKey: trpc.paper.outline.queryKey({ projectId }) })
    },
    [projectId, queryClient, trpc],
  )
  // The build callback is created before the controller, so it reads it through a ref.
  const controllerRef = useRef<CentralPanelController | null>(null)
  const onBuilt = useCallback((pdfRelPath: string, sourceRelPath: string): void => {
    const panel = controllerRef.current
    if (!panel || panel.editor.tabs.some((tab) => tab.relPath === pdfRelPath)) return
    // Open the PDF beside the source and keep the source focused for typing.
    panel.editor.openFile(pdfRelPath).then(
      () => panel.selectFile(sourceRelPath),
      (cause: unknown) => setOpenError(`${pdfRelPath}: ${String(cause)}`),
    )
  }, [])
  const controller = useCentralPanel({
    client,
    workspaceId,
    projectId,
    settings,
    onSaved,
    onBuilt,
  })
  controllerRef.current = controller
  const [sourceRequest, setSourceRequest] = useState<{
    relPath: string
    line: number
    column: number
    nonce: number
  } | null>(null)

  // Open the main .tex and, when it was built before, its PDF beside it, once per paper.
  const openedFor = useRef<string | null>(null)
  const openFile = controller.openFile
  useEffect(() => {
    if (!rootRelPath || openedFor.current === workspaceId) return
    openedFor.current = workspaceId
    openFile(rootRelPath)
    const pdf = pdfFor(rootRelPath, effectiveOutputDir)
    client.files.stat.query({ workspaceId, relPath: pdf }).then(
      (stat) => {
        if (stat.exists) openFile(pdf)
      },
      (cause: unknown) => setOpenError(`${pdf}: ${String(cause)}`),
    )
  }, [client, effectiveOutputDir, openFile, rootRelPath, workspaceId])

  const outlineSection = (
    <CollapsibleSection
      title={t("Outline")}
      open={outlineOpen}
      onOpenChange={setOutlineOpen}
      testId="paper-outline-section"
      className={outlineOpen ? "max-h-[45%] shrink-0 border-border border-b" : "shrink-0"}
    >
      <div className="min-h-0 overflow-y-auto pb-1 text-xs">
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
      </div>
    </CollapsibleSection>
  )

  return (
    <div data-testid="paper-editor" className="flex min-h-0 flex-1 flex-col">
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
          filesPanelOpen={leftColumnOpen}
          onFilesPanelOpenChange={setLeftColumnOpen}
          pdfBesideSource={true}
          sourceRequest={sourceRequest}
          leftColumn={{
            top: outlineSection,
            filesOpen,
            onFilesOpenChange: setFilesOpen,
          }}
        />
      </div>
      <PaperSyncBar
        projectId={projectId}
        workspaceId={workspaceId}
        lastSyncAt={lastSyncAt}
        hasRemote={hasRemote}
        confirmCommit={settings.confirmOverleafCommit}
        outputDir={outputDir}
        defaultOutputDir={settings.latexOutputDir}
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
