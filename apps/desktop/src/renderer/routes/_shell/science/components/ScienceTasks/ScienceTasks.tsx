import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useMemo } from "react"
import { readDefaultAgentId } from "../../../../../preferences/preferences"
import { useTRPC } from "../../../../../trpc/react"
import { setPendingTaskSession } from "../../../projects/-pendingTaskSession"
import { ScienceTabShell } from "../ScienceTabShell"
import { type TaskDraft, type TaskRecord, type TaskStatus, TasksWorkspace } from "./TasksWorkspace"

function selectorFor(task: TaskRecord): { id: string } | { sourceStart: number } {
  return task.id ? { id: task.id } : { sourceStart: task.source.start }
}

/** Global Tasks science tab. TODO Markdown remains the only task store. */
export function ScienceTasks() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

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

  const tasks = (listing.data?.tasks ?? []) as TaskRecord[]
  const sources = listing.data?.sources ?? []
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
      null,
    [
      listing.error,
      createTask.error,
      updateTask.error,
      deleteTask.error,
      moveTask.error,
      startSession.error,
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
      testId="science-tasks"
      title="Tasks"
      subtitle="Every project's TODO Markdown, in one place"
    >
      {listing.isLoading ? (
        <div className="grid min-h-0 flex-1 place-items-center text-muted-foreground text-sm">
          Loading tasks…
        </div>
      ) : (
        <TasksWorkspace
          tasks={tasks}
          sources={sources}
          agents={agents.data ?? []}
          defaultAgentId={readDefaultAgentId()}
          busy={busy}
          error={error}
          onCreate={create}
          onUpdate={update}
          onDelete={remove}
          onMove={move}
          onRun={run}
        />
      )}
    </ScienceTabShell>
  )
}
