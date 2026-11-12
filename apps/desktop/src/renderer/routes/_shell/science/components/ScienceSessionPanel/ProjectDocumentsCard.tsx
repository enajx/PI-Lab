import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { useTranslate } from "../../../../../i18n/language"
import { useTRPC } from "../../../../../trpc/react"
import {
  readProjectPinnedPanels,
  writeProjectPinnedPanels,
} from "../../../projects/-workspaceState"
import { RightSidebar } from "../../../projects/components/RightSidebar"

/**
 * The project's documents in a science view's right panel: the project view's right
 * sidebar (Research, TODOs, Files, Diary and the pinned Markdown panels, with the same
 * pin button), in the project's main folder. The pinned panels are the project's own
 * list, shared with the project view. `onCollapse` is the sidebar's collapse button,
 * or null for none (the panel has its collapse button elsewhere). Files the Files tab
 * opens go to `onOpenFile`. The parent keys it by project.
 */
export function ProjectDocumentsCard({
  projectId,
  activeId,
  onActiveIdChange,
  onCollapse,
  onOpenFile,
}: {
  projectId: string
  activeId: string
  onActiveIdChange: (id: string) => void
  onCollapse: (() => void) | null
  onOpenFile: (relPath: string) => void
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const capabilities = useQuery(trpc.projects.capabilities.queryOptions({ id: projectId }))
  const ensureMain = useMutation(trpc.workspaces.ensureMain.mutationOptions())
  const ensureMainRef = useRef(ensureMain.mutateAsync)
  ensureMainRef.current = ensureMain.mutateAsync
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  // Same pattern as the Project view: only the still-active run applies its result;
  // errors show from `ensureMain.error`.
  useEffect(() => {
    let active = true
    ensureMainRef.current({ projectId }).then(
      (workspace) => {
        if (active) setWorkspaceId(workspace.id)
      },
      () => undefined,
    )
    return () => {
      active = false
    }
  }, [projectId])

  const [pinnedPanels, setPinnedPanels] = useState(() => readProjectPinnedPanels(projectId))
  useEffect(() => writeProjectPinnedPanels(projectId, pinnedPanels), [projectId, pinnedPanels])

  if (!workspaceId) {
    return (
      <div
        data-testid="project-documents-loading"
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border"
      >
        {ensureMain.error ? (
          <p role="alert" className="cursor-text select-text p-3 text-destructive text-xs">
            {ensureMain.error.message}
          </p>
        ) : (
          <p className="p-3 text-muted-foreground text-xs">{t("Loading…")}</p>
        )}
      </div>
    )
  }
  return (
    <RightSidebar
      projectId={projectId}
      workspaceId={workspaceId}
      onOpenFile={onOpenFile}
      activeId={activeId}
      onActiveIdChange={onActiveIdChange}
      onCollapse={onCollapse}
      pinnedPanels={pinnedPanels}
      onPinFile={(relPath) =>
        setPinnedPanels((prev) => (prev.includes(relPath) ? prev : [...prev, relPath]))
      }
      onUnpinFile={(relPath) => setPinnedPanels((prev) => prev.filter((path) => path !== relPath))}
      gitAvailable={capabilities.data?.git === true}
      filesPanelOpen={false}
    />
  )
}
