import type { Project } from "@skipper/local-db"
import { cn } from "@skipper/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { useTRPC } from "../../../../../trpc/react"
import { deriveProjectState, type ProjectState } from "../../utils/deriveProjectState"
import { projectGradient } from "../../utils/projectGradient"
import { readImageFileAsDataUrl } from "./utils/readImageFileAsDataUrl"

/**
 * A single dashboard project card (md/02 — "Dashboard & project cards", Notion-
 * database style). Two stacked regions:
 *
 *   - a **header image area** — the project's thumbnail if it has one, else a
 *     deterministic grainy gradient seeded from the project id. Dropping an
 *     image file onto it reads the file into a `data:` URL and persists it via
 *     `projects.setThumbnail`, then the card re-renders from the refreshed list.
 *   - an **info area** — the project name, a status badge from
 *     `deriveProjectState`, and (when available) the project's current TODO line.
 *
 * Clicking the card opens the project's route. This is a deliberately minimal
 * first pass: the "glowy edge" / animated polish and the richer card contents
 * (next TODO, experiments, results) are reflected by `deriveProjectState`'s
 * inputs but left visually plain until specced.
 */

const STATUS_LABEL: Record<ProjectState, string> = {
  idle: "Idle",
  active: "Active",
  attention: "Needs attention",
}

const STATUS_DOT: Record<ProjectState, string> = {
  idle: "bg-muted-foreground/40",
  active: "bg-emerald-500",
  attention: "bg-red-500",
}

interface ProjectCardProps {
  project: Project
}

export function ProjectCard({ project }: ProjectCardProps) {
  const trpc = useTRPC()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [isDragOver, setIsDragOver] = useState(false)

  // Workspace count + working-tree changes drive the card's status. Both are
  // best-effort reads (the card still renders while they resolve); attention is
  // not yet sourced, so it stays 0 for v1 (see deriveProjectState).
  const workspacesQuery = useQuery(trpc.workspaces.list.queryOptions({ projectId: project.id }))
  const sessionCount = workspacesQuery.data?.length ?? 0

  const setThumbnail = useMutation(
    trpc.projects.setThumbnail.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() })
      },
    }),
  )

  const state = deriveProjectState({ sessionCount, changeCount: 0, attentionCount: 0 })

  const openProject = () => {
    void navigate({ to: "/projects/$projectId", params: { projectId: project.id } })
  }

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault()
    setIsDragOver(false)
    const file = event.dataTransfer.files[0]
    if (!file?.type.startsWith("image/")) return
    const dataUrl = await readImageFileAsDataUrl(file)
    if (!dataUrl) return
    await setThumbnail.mutateAsync({ id: project.id, dataUrl })
  }

  const gradient = projectGradient(project.id)

  return (
    <div
      data-testid="project-card"
      data-project-id={project.id}
      data-state={state}
      className={cn(
        "group flex flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-colors",
        isDragOver && "border-brand ring-2 ring-brand/40",
      )}
    >
      {/*
       * Header image + drop zone: the project's thumbnail, or a deterministic
       * grainy gradient when none is set. Dropping an image file here sets the
       * thumbnail. The drag handlers live on this presentational region (not the
       * card root or the info button) so the keyboard-activable target stays the
       * info button below.
       */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop has no keyboard equivalent and no single semantic element; this region is purely a visual drop target — the card's actions live in the info button. */}
      <div
        data-testid="project-card-image"
        className="relative h-32 w-full shrink-0 overflow-hidden"
        style={
          project.thumbnail
            ? undefined
            : { backgroundImage: gradient.background, backgroundColor: "var(--muted)" }
        }
        onDragOver={(event) => {
          event.preventDefault()
          setIsDragOver(true)
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(event) => void onDrop(event)}
      >
        {project.thumbnail ? (
          <img src={project.thumbnail} alt="" className="size-full object-cover" />
        ) : (
          // Subtle grain overlay over the gradient (md/02 — "grainy").
          <div
            aria-hidden
            className="absolute inset-0 opacity-20 mix-blend-overlay"
            style={{
              backgroundImage: `url("${gradient.grainUrl}")`,
              backgroundSize: "120px 120px",
            }}
          />
        )}
        {isDragOver ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 text-foreground text-xs">
            Drop image to set thumbnail
          </div>
        ) : null}
      </div>

      {/* Info area: clicking it opens the project (the keyboard-accessible target). */}
      <button
        type="button"
        data-testid="project-card-open"
        onClick={openProject}
        className="flex flex-col items-start gap-1.5 p-3 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40"
      >
        <div className="flex w-full items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
            {project.name}
          </span>
          <span
            data-testid="project-card-status"
            data-state={state}
            className="inline-flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs"
          >
            <span className={cn("size-2 rounded-full", STATUS_DOT[state])} aria-hidden />
            {STATUS_LABEL[state]}
          </span>
        </div>
      </button>
    </div>
  )
}
