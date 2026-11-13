import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useMemo, useState } from "react"
import { HeaderShortcuts } from "../../../../../components/HeaderShortcuts/HeaderShortcuts"
import { ProjectMarkdownChoice } from "../../../../../components/ProjectMarkdownChoice"
import { useTranslate } from "../../../../../i18n/language"
import {
  readDefaultAgentId,
  useSciencePanelWidth,
  useTasksProject,
} from "../../../../../preferences/preferences"
import { useTRPC } from "../../../../../trpc/react"
import { setPendingTaskSession } from "../../../projects/-pendingTaskSession"
import { ProjectPicker } from "../ProjectPicker"
import {
  type FocusSessionRequest,
  SciencePanelCollapsedBar,
  SciencePanelDiaryButton,
  ScienceSessionPanel,
  type ScienceSessionRequest,
  useFocusSessionRequest,
  useSciencePanel,
  useSciencePanelRow,
} from "../ScienceSessionPanel"
import { PANEL_DRAWN_MIN_WIDTH, TASKS_BOARD_MIN_WIDTH } from "../ScienceSessionPanel/panelFit"
import { ScienceTabShell } from "../ScienceTabShell"
import { type TaskDraft, type TaskRecord, type TaskStatus, TasksWorkspace } from "./TasksWorkspace"

function selectorFor(task: TaskRecord): { id: string } | { sourceStart: number } {
  return task.id ? { id: task.id } : { sourceStart: task.source.start }
}

/**
 * Global Tasks science tab. TODO Markdown remains the only task store. A project
 * picker in the top bar shows All projects (the default) or one project; it
 * remembers the last choice. `initialProjectId` (from `?projectId=`) selects a
 * project and becomes the remembered one; the picker always wins afterwards.
 */
export function ScienceTasks({
  initialProjectId,
  focusSession,
}: {
  initialProjectId?: string
  /** An agent session of the initial project to open and focus in the session panel, or null. */
  focusSession: FocusSessionRequest | null
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [savedProjectId, setSavedProjectId] = useTasksProject()
  // The picker remembers the choice and replaces the address ("" = All projects).
  const chooseProject = (projectId: string): void => {
    setSavedProjectId(projectId)
    void navigate({
      to: "/science/tasks",
      search: projectId ? { projectId } : {},
      replace: true,
    })
  }
  // A project given in the address wins and becomes the remembered one.
  useEffect(() => {
    if (initialProjectId) setSavedProjectId(initialProjectId)
  }, [initialProjectId, setSavedProjectId])

  const listing = useQuery({
    ...trpc.science.tasks.list.queryOptions(),
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  })
  const agents = useQuery(trpc.agents.list.queryOptions(undefined, { staleTime: 0 }))

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.science.tasks.list.queryKey() })
  }
  const mutationOptions = {
    onSuccess: refresh,
    onError: refresh,
  }
  const createTask = useMutation(trpc.science.tasks.create.mutationOptions(mutationOptions))
  const updateTask = useMutation(trpc.science.tasks.update.mutationOptions(mutationOptions))
  const deleteTask = useMutation(trpc.science.tasks.delete.mutationOptions(mutationOptions))
  const moveTask = useMutation(trpc.science.tasks.move.mutationOptions(mutationOptions))
  const startSession = useMutation(trpc.sessions.start.mutationOptions())
  // A skill session a top bar button started, until the session panel opens it.
  const [sessionRequest, setSessionRequest] = useState<ScienceSessionRequest | null>(null)
  const clearSessionRequest = useCallback(() => setSessionRequest(null), [])
  useFocusSessionRequest(initialProjectId, focusSession, setSessionRequest)
  // The board and the right panel fit the row's width (no horizontal scroll).
  const row = useSciencePanelRow(
    useSciencePanel("tasks"),
    useSciencePanelWidth(),
    PANEL_DRAWN_MIN_WIDTH,
    null,
    {
      preferred: TASKS_BOARD_MIN_WIDTH,
      min: TASKS_BOARD_MIN_WIDTH,
    },
  )
  const panel = row.panel
  const [shortcutError, setShortcutError] = useState<string | null>(null)

  const tasks = (listing.data?.tasks ?? []) as TaskRecord[]
  const sources = listing.data?.sources ?? []
  const wanted = initialProjectId ?? savedProjectId
  // A project that is no longer listed falls back to All projects once the list loads.
  const selectedProjectId =
    listing.data === undefined || sources.some((source) => source.projectId === wanted)
      ? wanted
      : ""
  // Sessions start in the selected project; "All projects" has none.
  const selectedSource = sources.find((source) => source.projectId === selectedProjectId)
  const busy =
    createTask.isPending ||
    updateTask.isPending ||
    deleteTask.isPending ||
    moveTask.isPending ||
    startSession.isPending
  const error = useMemo(
    () =>
      listing.error?.message ??
      createTask.error?.message ??
      updateTask.error?.message ??
      deleteTask.error?.message ??
      moveTask.error?.message ??
      startSession.error?.message ??
      shortcutError ??
      null,
    [
      listing.error,
      createTask.error,
      updateTask.error,
      deleteTask.error,
      moveTask.error,
      startSession.error,
      shortcutError,
    ],
  )

  const sourceFor = (projectId: string, relPath: string) =>
    sources.find(
      (source) => source.projectId === projectId && (source.relPath ?? "TODO.md") === relPath,
    )

  const create = async (projectId: string, relPath: string, draft: TaskDraft) => {
    const source = sourceFor(projectId, relPath)
    await createTask.mutateAsync({
      projectId,
      relPath,
      expectedRevision: source?.revision ?? null,
      ...draft,
    })
  }

  const update = async (task: TaskRecord, draft: TaskDraft) => {
    await updateTask.mutateAsync({
      projectId: task.projectId,
      relPath: task.relPath,
      expectedRevision: task.revision,
      selector: selectorFor(task),
      ...draft,
    })
  }

  const remove = async (task: TaskRecord) => {
    await deleteTask.mutateAsync({
      projectId: task.projectId,
      relPath: task.relPath,
      expectedRevision: task.revision,
      selector: selectorFor(task),
    })
  }

  const move = async (
    task: TaskRecord,
    target: { kind: "status"; status: TaskStatus } | { kind: "heading"; headingKey: string },
  ) => {
    await moveTask.mutateAsync({
      projectId: task.projectId,
      relPath: task.relPath,
      expectedRevision: task.revision,
      selector: selectorFor(task),
      destination:
        target.kind === "status"
          ? { mode: "status", status: target.status }
          : { mode: "heading", headingKey: target.headingKey },
    })
  }

  const run = async (task: TaskRecord, agentId: string, prompt: string) => {
    if (!task.id) {
      await update(task, {
        title: task.title,
        details: task.details,
        status: task.status,
        priority: task.priority,
        labels: task.labels,
        owner: task.owner,
      })
    }
    const result = await startSession.mutateAsync({
      projectId: task.projectId,
      // Task agents open as tabs in the Project view.
      origin: "project",
      agentId,
      prompt,
      workspaceMode: "main",
    })
    setPendingTaskSession(task.projectId, {
      kind: "agent",
      sessionId: result.sessionId,
      label: task.title,
      wsKind: result.kind,
      launch: { type: "agent", agentId, workspaceMode: "main" },
    })
    await navigate({ to: "/projects/$projectId", params: { projectId: task.projectId } })
  }

  return (
    <ScienceTabShell
      layout="cards"
      testId="science-tasks"
      title={t("Tasks")}
      subtitle={t("Every project's TODO Markdown, in one place")}
      actions={
        <HeaderShortcuts
          view="tasks"
          projectId={selectedSource?.projectId ?? null}
          picker={
            <ProjectPicker
              testId="tasks-project-select"
              label={t("Project filter")}
              help={t("Filter tasks by project")}
              value={selectedProjectId}
              projects={sources.map((source) => ({
                id: source.projectId,
                name: source.projectName,
              }))}
              allLabel={t("All projects")}
              onChange={chooseProject}
            />
          }
          builtins={[
            {
              id: "research-diary",
              label: t("Research diary"),
              node: (
                <SciencePanelDiaryButton
                  testId="tasks-research-diary"
                  panel={panel}
                  disabled={!selectedSource}
                />
              ),
            },
          ]}
          onError={setShortcutError}
          onSkillSessionStarted={(session) =>
            selectedSource
              ? setSessionRequest({
                  projectId: selectedSource.projectId,
                  pane: {
                    kind: "agent",
                    sessionId: session.sessionId,
                    label: session.label,
                    wsKind: session.kind,
                    launch: { type: "agent", agentId: session.agentId, workspaceMode: "policy" },
                  },
                })
              : undefined
          }
        />
      }
    >
      {/* The board and the right panel are separate rounded cards, 12px apart. */}
      <div ref={row.rowRef} className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        <div
          data-testid="tasks-board"
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-panel-border"
        >
          {listing.isLoading ? (
            <div className="grid min-h-0 flex-1 place-items-center text-muted-foreground text-sm">
              {t("Loading tasks…")}
            </div>
          ) : (
            <>
              {sources
                .filter(
                  (source) =>
                    source.state !== "ready" &&
                    (!selectedProjectId || source.projectId === selectedProjectId),
                )
                .map((source) => (
                  <div
                    key={source.projectId}
                    data-testid={`tasks-source-choice-${source.projectId}`}
                    className="border-border border-b px-4 py-3"
                  >
                    <p className="mb-2 text-sm">
                      {t("Choose a task file for {project}").replace(
                        "{project}",
                        source.projectName,
                      )}
                    </p>
                    <ProjectMarkdownChoice
                      projectId={source.projectId}
                      kind="tasks"
                      currentPath={source.relPath}
                    />
                  </div>
                ))}
              <TasksWorkspace
                tasks={tasks}
                sources={sources}
                projectId={selectedProjectId}
                agents={agents.data ?? []}
                defaultAgentId={readDefaultAgentId()}
                busy={busy}
                error={error}
                onCreate={create}
                onUpdate={update}
                onDelete={remove}
                onMove={move}
                onRun={run}
                toolbarEnd={null}
              />
            </>
          )}
        </div>
        <SciencePanelCollapsedBar testId="tasks-collapsed-bar" panel={panel} />
        <ScienceSessionPanel
          view="tasks"
          panel={panel}
          width={row.width}
          project={
            selectedSource
              ? { id: selectedSource.projectId, name: selectedSource.projectName }
              : null
          }
          openSession={sessionRequest}
          onSessionOpened={clearSessionRequest}
        />
      </div>
    </ScienceTabShell>
  )
}
