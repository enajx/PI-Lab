import type { Project } from "@pi-lab/local-db"
import { cn } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { useTRPC } from "../../../../../trpc/react"
import { deriveProjectState, type ProjectState } from "../../utils/deriveProjectState"
import { projectGradient } from "../../utils/projectGradient"
import { useGradientPlayState } from "./hooks/useGradientPlayState"
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
 *     `deriveProjectState`, with live agent activity determining whether the
 *     status is empty, working, or paused.
 *
 * Clicking the card opens the project's route. This is a deliberately minimal
 * first pass: the "glowy edge" / animated polish and the richer card contents
 * (next TODO, experiments, results) are reflected by `deriveProjectState`'s
 * inputs but left visually plain until specced.
 */

const STATUS_LABEL: Record<ProjectState, string> = {
  idle: "No active agents",
  active: "Working",
  attention: "Paused",
}

const STATUS_DOT: Record<ProjectState, string> = {
  idle: "border border-muted-foreground/50",
  active: "bg-emerald-500",
  attention: "bg-red-500",
}

const GRADIENT_LAYER_NAMES = ["a", "b", "c"] as const

interface ProjectCardProps {
  project: Project
}

export function ProjectCard({ project }: ProjectCardProps) {
  const trpc = useTRPC()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [isDragOver, setIsDragOver] = useState(false)

  const activityQuery = useQuery(trpc.sessions.activity.queryOptions())
  const agentStates = (activityQuery.data ?? [])
    .filter((activity) => activity.projectId === project.id)
    .map((activity) => activity.state)

  const setThumbnail = useMutation(
    trpc.projects.setThumbnail.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() })
      },
    }),
  )

  const state = deriveProjectState({
    sessionCount: agentStates.includes("working") ? 1 : 0,
    changeCount: 0,
    attentionCount: agentStates.includes("waiting") ? 1 : 0,
  })

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
  // The animated gradient layer (no-thumbnail header only). The play-state hook
  // pauses its morph while off-screen or while the window is unfocused/hidden,
  // toggling the element's `animation-play-state` directly (no re-render).
  const gradientRef = useRef<HTMLDivElement | null>(null)
  useGradientPlayState(gradientRef)

  return (
    <div
      data-testid="project-card"
      data-project-id={project.id}
      data-state={state}
      className={cn(
        "group flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-colors",
        isDragOver && "border-brand ring-2 ring-brand/40",
      )}
    >
      {/*
       * Header image + drop zone: the project's thumbnail, or a deterministic
       * grainy gradient when none is set. A plain click here opens the project
       * (mirroring the info button below, so the whole card is clickable);
       * dropping an image file here sets the thumbnail instead (a drop fires
       * `onDrop`, not a click, so a completed drag never navigates). The
       * keyboard-activable target stays the info button below.
       */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop has no keyboard equivalent and no single semantic element; this region is a visual drop target that also opens the project on click, mirroring the keyboard-reachable info button. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the click only mirrors the info button's navigation, which is the real keyboard-activable control; a key handler / extra tab stop here would be a redundant duplicate target. */}
      <div
        data-testid="project-card-image"
        className="relative isolate h-32 w-full shrink-0 overflow-hidden"
        style={project.thumbnail ? undefined : { backgroundColor: "var(--muted)" }}
        onClick={openProject}
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
          <>
            {/* A stationary seeded pastel base containing three independently
                animated fields. Their seeded geometry and motion families vary;
                only child transforms move, while the card, base, and grain stay
                still. */}
            <div
              data-testid="project-card-gradient"
              data-gradient-palette={gradient.variant.palette}
              data-gradient-shape={gradient.variant.shape}
              data-gradient-motion={gradient.variant.motion}
              aria-hidden
              ref={gradientRef}
              className={`project-gradient-field project-gradient-motion-${gradient.variant.motion}`}
              style={
                {
                  backgroundImage: gradient.background,
                  "--layer-a-duration": `${gradient.animation.durationSec}s`,
                  "--layer-b-duration": `${gradient.animation.durationSec + 2.5}s`,
                  "--layer-c-duration": `${gradient.animation.durationSec + 5}s`,
                  "--layer-a-delay": `${gradient.animation.delaySec}s`,
                  "--layer-b-delay": `${gradient.animation.delaySec - 0.7}s`,
                  "--layer-c-delay": `${gradient.animation.delaySec - 1.3}s`,
                } as React.CSSProperties
              }
            >
              {gradient.layerBackgrounds.map((backgroundImage, index) => {
                const name = GRADIENT_LAYER_NAMES[index]
                return (
                  <div
                    key={name}
                    data-testid="project-card-gradient-layer"
                    data-layer={name}
                    className={`project-gradient-layer project-gradient-layer-${name}`}
                    style={{ backgroundImage }}
                  />
                )
              })}
            </div>
            {/* Static film grain remains above the fields. The cached turbulence
                tile supplies irregular noise while two fine dot screens ensure
                the texture remains legible over the new light palettes. */}
            <div
              data-testid="project-card-gradient-grain"
              aria-hidden
              className="pointer-events-none absolute inset-0 opacity-50 mix-blend-soft-light"
              style={{
                backgroundImage: `url("${gradient.grainUrl}"), radial-gradient(circle at 25% 35%, hsl(0 0% 0% / 0.26) 0 0.6px, transparent 0.9px), radial-gradient(circle at 70% 62%, hsl(0 0% 100% / 0.42) 0 0.55px, transparent 0.9px)`,
                backgroundSize: "180px 180px, 5px 5px, 7px 7px",
              }}
            />
          </>
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
        data-feature-label={project.name}
        data-feature-help={`Open the ${project.name} project workspace; drop an image on the card header to change its thumbnail`}
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
