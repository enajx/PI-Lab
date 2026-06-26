import type { EditorSettings } from "@skipper/local-db"
import { cn } from "@skipper/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { EdgeResizeHandle } from "../../../components/EdgeResizeHandle"
import { DEFAULT_EDITOR_SETTINGS } from "../../../Editor/hooks/useEditorBuffers"
import {
  RIGHT_SIDEBAR_MAX_WIDTH,
  RIGHT_SIDEBAR_MIN_WIDTH,
  useRightSidebarWidth,
  useSidebarCollapsed,
} from "../../../preferences/preferences"
import { useTRPC, useTRPCClient } from "../../../trpc/react"
import { titleBarControlClass, titleBarInsetHeaderClass } from "../titleBar"
import { CentralPanel, useCentralPanel } from "./components/CentralPanel"
import { RightSidebar } from "./components/RightSidebar"

/**
 * Project route (md/02; plan "Settings panel, project-view rework") — the rich
 * workspace surface a project card opens directly into. The central panel holds
 * whatever the user opens (an agent, a plain terminal, or a file in the built-in
 * editor) as tabs; the right sidebar (Research / TODOs / Files, + an optional
 * Code changes panel) sits alongside it, and can be collapsed away to give the
 * central panel the full width (a slim affordance brings it back).
 *
 * TanStack reuses the route component across `/projects/A → /projects/B`, so the
 * actual view is keyed on `projectId` ({@link ProjectWorkspace}) — a fresh mount
 * per project resets the central panel's open tabs/sessions and editor buffers so
 * one project's state never leaks into another.
 */
export const Route = createFileRoute("/_shell/projects/$projectId")({
  component: ProjectRoute,
})

function ProjectRoute() {
  const { projectId } = Route.useParams()
  return <ProjectWorkspace key={projectId} projectId={projectId} />
}

/**
 * Everything binds to the project's **main checkout** — a `kind:"branch"`
 * workspace ensured once on mount via `workspaces.ensureMain` (idempotent). Files
 * read/write through the `files` router against that workspace with no agent
 * required; opening an agent (`sessions.start`) or a terminal
 * (`workspaces.spawnTerminal`) attaches a session pane in the central panel.
 */
function ProjectWorkspace({ projectId }: { projectId: string }) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()

  const projectQuery = useQuery(trpc.projects.get.queryOptions({ id: projectId }))
  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const editorSettings: EditorSettings = settingsQuery.data?.editor ?? DEFAULT_EDITOR_SETTINGS

  const updateEditor = useMutation(
    trpc.settings.updateEditor.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
      },
    }),
  )
  const onUpdateEditorSettings = (patch: Partial<EditorSettings>) => updateEditor.mutate(patch)

  // The right sidebar defaults to EXPANDED on every project open (session state, keyed by
  // project — not persisted), so opening a project always shows it. Collapsing it (the
  // sidebar's collapse button or the central panel's expand button) lasts for this project
  // view; switching/reopening a project shows it expanded again. Its width when expanded is a
  // separately-persisted, edge-resizable preference.
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false)
  const [rightSidebarWidth, setRightSidebarWidth] = useRightSidebarWidth()

  // When the left sidebar is collapsed, the traffic lights ride this view's title-bar
  // strip, so the header clears + drags around them (the path text stays selectable).
  const [collapsed] = useSidebarCollapsed()

  // Ensure the project's main-checkout (branch) workspace exists, once on mount
  // (this component is keyed by project, so a switch remounts and re-ensures).
  const ensureMain = useMutation(trpc.workspaces.ensureMain.mutationOptions())
  const ensureMainRef = useRef(ensureMain.mutateAsync)
  ensureMainRef.current = ensureMain.mutateAsync
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const firedRef = useRef(false)

  useEffect(() => {
    if (firedRef.current) return
    firedRef.current = true
    let cancelled = false
    ensureMainRef
      .current({ projectId })
      .then((workspace) => {
        if (!cancelled) setWorkspaceId(workspace.id)
      })
      .catch(() => {
        // Surfaced below via ensureMain.isError; nothing to do here.
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  // Hooks are unconditional; the central panel does no file I/O until a workspace
  // id is set and the panel is rendered, so an empty id pre-resolve is inert.
  const controller = useCentralPanel({
    client,
    workspaceId: workspaceId ?? "",
    projectId,
    settings: editorSettings,
  })

  if (projectQuery.isError) {
    return (
      <div className="p-8">
        <p data-testid="project-error" className="cursor-text select-text text-destructive text-sm">
          {projectQuery.error.message}
        </p>
      </div>
    )
  }

  const project = projectQuery.data

  return (
    <div data-testid="project-view" className="flex h-full flex-col gap-3 p-4">
      <header
        className={cn(
          "flex items-center justify-between gap-3",
          titleBarInsetHeaderClass(collapsed),
        )}
      >
        <div className={cn("flex min-w-0 flex-col", titleBarControlClass(collapsed))}>
          <h1 className="truncate font-semibold text-foreground text-sm tracking-tight">
            {project?.name ?? "Loading…"}
          </h1>
          {project ? (
            <p className="cursor-text select-text truncate text-muted-foreground text-xs">
              {project.repoPath}
            </p>
          ) : null}
        </div>
      </header>

      {workspaceId ? (
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <CentralPanel
              controller={controller}
              client={client}
              workspaceId={workspaceId}
              settings={editorSettings}
              onUpdateEditorSettings={onUpdateEditorSettings}
              rightSidebarCollapsed={rightSidebarCollapsed}
              onExpandRightSidebar={() => setRightSidebarCollapsed(false)}
            />
          </div>
          {rightSidebarCollapsed ? null : (
            <div className="relative flex min-h-0 shrink-0" style={{ width: rightSidebarWidth }}>
              <EdgeResizeHandle
                side="left"
                width={rightSidebarWidth}
                onResize={setRightSidebarWidth}
                min={RIGHT_SIDEBAR_MIN_WIDTH}
                max={RIGHT_SIDEBAR_MAX_WIDTH}
                testId="right-sidebar-edge-drag"
              />
              <RightSidebar
                workspaceId={workspaceId}
                onOpenFile={controller.openFile}
                onCollapse={() => setRightSidebarCollapsed(true)}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-sm">
          {ensureMain.isError ? (
            <span data-testid="project-error" className="cursor-text select-text text-destructive">
              {ensureMain.error.message}
            </span>
          ) : (
            "Opening project…"
          )}
        </div>
      )}
    </div>
  )
}
