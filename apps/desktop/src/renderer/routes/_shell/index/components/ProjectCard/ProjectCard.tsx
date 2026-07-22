import type { Project, ProjectMetadata } from "@pi-lab/local-db"
import { cn } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import {
  BookOpen,
  CalendarClock,
  FlaskConical,
  ImagePlus,
  Link2,
  Pencil,
  Sparkles,
  Users,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { ProjectWorkflowControl } from "../../../../../components/ProjectWorkflow"
import { readFetchExperimentsInstructions } from "../../../../../preferences/preferences"
import { useTRPC } from "../../../../../trpc/react"
import { setPendingLaunch } from "../../../projects/-pendingLaunch"
import { deriveProjectState, type ProjectState } from "../../utils/deriveProjectState"
import { hashString, projectGradient, sampleThemePalette } from "../../utils/projectGradient"
import { EditProjectDialog } from "./EditProjectDialog"
import { useGradientPlayState } from "./hooks/useGradientPlayState"
import { deriveLinkName } from "./utils/deriveLinkName"
import { readImageFileAsDataUrl } from "./utils/readImageFileAsDataUrl"

/**
 * A single dashboard project card (md/02 — "Dashboard & project cards", Notion-
 * database style). Two stacked regions:
 *
 *   - a **header image area** — the project's thumbnail if it has one, else a
 *     baked noisy-gradient seeded from the project's persisted `{ seed, palette }`
 *     (`projects.gradient`). The card shows exactly one artwork; right-clicking the
 *     header offers the two mutually-exclusive ways to change it: **Set thumbnail**
 *     (pick a local image or animated `.gif`) or **Generate new gradient** (sample
 *     a fresh one from the current app theme). Dropping an image also sets the
 *     thumbnail. Setting a thumbnail clears the gradient and vice-versa (enforced
 *     server-side). A project with neither yet captures a default gradient from the
 *     current theme on first render and persists it, so it stays fixed thereafter.
 *   - an **info area** — the project name and a status badge from
 *     `deriveProjectState`, with live agent activity determining whether the status
 *     is empty, working, or paused. An `active` project's gradient also drifts as a
 *     live activity cue.
 *
 * Clicking the card opens the project's route.
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

// Compact, icon-forward card-action button — modeled on the Caffeine title-bar
// control (small, subtle, bordered, `text-xs`). Icon-only so all three actions fit
// on one row without wrapping; discoverability comes from the per-button
// `data-feature-label` / `data-feature-help` hover-help and the native `title`.
const CARD_ACTION_CLASS =
  "inline-flex h-7 flex-1 items-center justify-center rounded-md border border-border text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-60"

interface ProjectCardProps {
  project: Project
}

export function ProjectCard({ project }: ProjectCardProps) {
  const trpc = useTRPC()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [isDragOver, setIsDragOver] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const activityQuery = useQuery(trpc.sessions.activity.queryOptions())
  const agentStates = (activityQuery.data ?? [])
    .filter((activity) => activity.projectId === project.id)
    .map((activity) => activity.state)

  const invalidateProjects = () =>
    void queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() })

  const setThumbnail = useMutation(
    trpc.projects.setThumbnail.mutationOptions({ onSuccess: invalidateProjects }),
  )
  const setGradient = useMutation(
    trpc.projects.setGradient.mutationOptions({ onSuccess: invalidateProjects }),
  )
  const setMetadata = useMutation(
    trpc.projects.setMetadata.mutationOptions({ onSuccess: invalidateProjects }),
  )

  const state = deriveProjectState({
    sessionCount: agentStates.includes("working") ? 1 : 0,
    changeCount: 0,
    attentionCount: agentStates.includes("waiting") ? 1 : 0,
  })

  const openProject = () => {
    void navigate({ to: "/projects/$projectId", params: { projectId: project.id } })
  }

  // Auto-research: record the launch intent and open the project **immediately** —
  // the project view picks the intent up on mount, runs the launch itself, and
  // attaches the returned session to its central panel (a failed launch surfaces
  // there). Navigating first means opening the project never waits on — nor gets
  // wedged by — the launch RPC (md/02 — Dashboard & project cards; `-pendingLaunch`).
  const onAutoResearch = () => {
    setPendingLaunch(project.id, { kind: "auto-research" })
    openProject()
  }

  const applyThumbnailFile = async (file: File | undefined) => {
    if (!file?.type.startsWith("image/")) return
    const dataUrl = await readImageFileAsDataUrl(file)
    if (!dataUrl) return
    await setThumbnail.mutateAsync({ id: project.id, dataUrl })
  }

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault()
    setIsDragOver(false)
    await applyThumbnailFile(event.dataTransfer.files[0])
  }

  const onFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = "" // allow re-selecting the same file later
    await applyThumbnailFile(file)
  }

  // Resolve the card's gradient source. A stored gradient wins; otherwise, when the
  // card has no thumbnail, sample the current theme once to seed a default. The
  // default is persisted below so it (and its captured palette) stays fixed across
  // restarts and later theme changes.
  const needsDefaultGradient = !project.thumbnail && !project.gradient
  const defaultGradient = useMemo(
    () =>
      needsDefaultGradient ? { seed: hashString(project.id), palette: sampleThemePalette() } : null,
    [needsDefaultGradient, project.id],
  )
  const gradientSource = project.gradient ?? defaultGradient
  const artwork = gradientSource
    ? projectGradient(gradientSource.seed, gradientSource.palette)
    : null

  // Persist the freshly-sampled default exactly once (the mutation refreshes the
  // list, after which `project.gradient` is set and this no longer fires).
  const persistDefault = setGradient.mutate
  useEffect(() => {
    if (!needsDefaultGradient || !defaultGradient) return
    persistDefault({ id: project.id, gradient: defaultGradient })
  }, [needsDefaultGradient, defaultGradient, project.id, persistDefault])

  const generateGradient = () => {
    setMenu(null)
    setGradient.mutate({
      id: project.id,
      gradient: { seed: Math.floor(Math.random() * 0x1_0000_0000), palette: sampleThemePalette() },
    })
  }

  const openFilePicker = () => {
    setMenu(null)
    fileInputRef.current?.click()
  }

  const openEditDialog = () => {
    setMenu(null)
    setEditing(true)
  }

  const saveMetadata = (metadata: ProjectMetadata | null) => {
    setEditing(false)
    setMetadata.mutate({ id: project.id, metadata })
  }

  // The animated gradient layer (no-thumbnail header only). The play-state hook
  // pauses drift unless the project is active and the card is on-screen/focused,
  // toggling `animation-play-state` directly (no re-render).
  const gradientRef = useRef<HTMLDivElement | null>(null)
  useGradientPlayState(gradientRef, state === "active")

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
      {/* Hidden picker for the "Set thumbnail" menu item; accepts images incl. `.gif`. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => void onFileChange(event)}
        data-testid="project-card-thumbnail-input"
      />
      {/*
       * Header image + drop zone: the project's thumbnail, or a baked noisy
       * gradient when none is set. A plain click opens the project (mirroring the
       * info button below, so the whole card is clickable); dropping an image sets
       * the thumbnail; right-clicking opens the artwork menu.
       */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop and right-click have no keyboard equivalent and no single semantic element; this region is a visual drop target that also opens the project on click, mirroring the keyboard-reachable info button. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the click only mirrors the info button's navigation, which is the real keyboard-activable control; a key handler / extra tab stop here would be a redundant duplicate target. */}
      <div
        data-testid="project-card-image"
        className="relative isolate h-32 w-full shrink-0 overflow-hidden"
        style={project.thumbnail ? undefined : { backgroundColor: "var(--muted)" }}
        onClick={openProject}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY })
        }}
        onDragOver={(event) => {
          event.preventDefault()
          setIsDragOver(true)
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(event) => void onDrop(event)}
      >
        {project.thumbnail ? (
          <img src={project.thumbnail} alt="" className="size-full object-cover" />
        ) : artwork ? (
          <>
            {/* A stationary seeded base with three independently drifted, baked
                noisy-gradient fields. Only child transforms move; the card, base,
                and grain stay still, so the SVG filters never re-rasterize. */}
            <div
              data-testid="project-card-gradient"
              data-gradient-motion={artwork.variant.motion}
              data-gradient-seed={gradientSource?.seed}
              aria-hidden
              ref={gradientRef}
              className={`project-gradient-field project-gradient-motion-${artwork.variant.motion}`}
              style={
                {
                  backgroundColor: artwork.baseColor,
                  backgroundImage: artwork.background,
                  "--layer-a-duration": `${artwork.animation.durationSec}s`,
                  "--layer-b-duration": `${artwork.animation.durationSec + 2.5}s`,
                  "--layer-c-duration": `${artwork.animation.durationSec + 5}s`,
                  "--layer-a-delay": `${artwork.animation.delaySec}s`,
                  "--layer-b-delay": `${artwork.animation.delaySec - 0.7}s`,
                  "--layer-c-delay": `${artwork.animation.delaySec - 1.3}s`,
                } as React.CSSProperties
              }
            >
              {artwork.layerBackgrounds.map((backgroundImage, index) => {
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
            {/* Static film grain over the fields: the baked turbulence tile plus two
                fine dot screens keep the texture legible over any palette. */}
            <div
              data-testid="project-card-gradient-grain"
              aria-hidden
              className="pointer-events-none absolute inset-0 opacity-50 mix-blend-soft-light"
              style={{
                backgroundImage: `url("${artwork.grainUrl}"), radial-gradient(circle at 25% 35%, hsl(0 0% 0% / 0.26) 0 0.6px, transparent 0.9px), radial-gradient(circle at 70% 62%, hsl(0 0% 100% / 0.42) 0 0.55px, transparent 0.9px)`,
                backgroundSize: "180px 180px, 5px 5px, 7px 7px",
              }}
            />
          </>
        ) : null}
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
        data-feature-help={`Open the ${project.name} project workspace; right-click the card header to set a thumbnail or generate a new gradient`}
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

      {/* Extra metadata (collaborators / venue / deadline / emoji tags / links)
          under the title — only the fields the user filled render. */}
      {project.metadata ? <ProjectCardMetadata metadata={project.metadata} /> : null}

      {/* Card actions pinned to the bottom: launch a placeholder auto-research
          session in an isolated worktree (interactive), plus the two stateful
          background workflow controls — "Fetch remote experiments" and "Project
          summary" — which run headlessly, cache their result per git-state, and
          open a result popup when done. See md/02 — Dashboard & project cards. */}
      <div className="mt-auto flex items-center gap-1.5 border-border border-t p-2">
        <button
          type="button"
          data-testid="project-card-auto-research"
          aria-label={`Auto-research ${project.name}`}
          title="Auto-research"
          data-feature-label={`Auto-research ${project.name}`}
          data-feature-help={`Open an isolated worktree agent session for ${project.name} and seed a placeholder AUTORESEARCH.md`}
          onClick={onAutoResearch}
          className={CARD_ACTION_CLASS}
        >
          <FlaskConical className="size-4 shrink-0" aria-hidden />
        </button>
        <ProjectWorkflowControl
          projectId={project.id}
          projectName={project.name}
          task="fetch-experiments"
          variant="compact"
          testId="project-card-fetch-experiments"
          instructions={readFetchExperimentsInstructions()}
        />
        <ProjectWorkflowControl
          projectId={project.id}
          projectName={project.name}
          task="summary"
          variant="compact"
          testId="project-card-summary"
        />
      </div>

      <ProjectCardMenu
        menu={menu}
        onClose={() => setMenu(null)}
        onSetThumbnail={openFilePicker}
        onGenerateGradient={generateGradient}
        onEditProject={openEditDialog}
      />

      {editing ? (
        <EditProjectDialog
          project={project}
          onClose={() => setEditing(false)}
          onSave={saveMetadata}
        />
      ) : null}
    </div>
  )
}

/** Format an ISO `YYYY-MM-DD` deadline as a readable local date (no TZ shift). */
function formatDeadline(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return iso
  const [, year, month, day] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day))
  return `Due ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
}

/**
 * The filled project metadata rendered under the card title. Each field is
 * independently gated: empty fields (and empty emoji/link lists) render nothing,
 * so the block only shows what the user actually entered.
 */
function ProjectCardMetadata({ metadata }: { metadata: ProjectMetadata }) {
  const emojiTags = metadata.emojiTags ?? []
  const links = metadata.referenceLinks ?? []
  const hasAny =
    Boolean(metadata.collaborators || metadata.venue || metadata.deadline) ||
    emojiTags.length > 0 ||
    links.length > 0
  if (!hasAny) return null

  return (
    <div
      data-testid="project-card-metadata"
      className="flex flex-col gap-1.5 px-3 pb-3 text-muted-foreground text-xs"
    >
      {metadata.collaborators ? (
        <div data-testid="project-card-collaborators" className="flex items-center gap-1.5">
          <Users className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{metadata.collaborators}</span>
        </div>
      ) : null}
      {metadata.venue ? (
        <div data-testid="project-card-venue" className="flex items-center gap-1.5">
          <BookOpen className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{metadata.venue}</span>
        </div>
      ) : null}
      {metadata.deadline ? (
        <div data-testid="project-card-deadline" className="flex items-center gap-1.5">
          <CalendarClock className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{formatDeadline(metadata.deadline)}</span>
        </div>
      ) : null}
      {emojiTags.length > 0 ? (
        <div data-testid="project-card-emoji-tags" className="flex flex-wrap gap-1 text-sm">
          {emojiTags.map((emoji) => (
            <span key={emoji} data-testid="project-card-emoji-tag">
              {emoji}
            </span>
          ))}
        </div>
      ) : null}
      {links.length > 0 ? (
        <div data-testid="project-card-links" className="flex flex-col gap-1">
          {links.map((link, index) => (
            <a
              // biome-ignore lint/suspicious/noArrayIndexKey: reference links render in a fixed, non-reordered order, and the index is exactly what disambiguates two links that share the same URL (which would otherwise collide on key).
              key={`${index}:${link.url}`}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              data-testid="project-card-link"
              className="flex items-center gap-1.5 text-accent-brand underline underline-offset-2"
            >
              <Link2 className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{deriveLinkName(link.url)}</span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The right-click menu for a project card's header, positioned at the cursor. Two
 * mutually-exclusive artwork actions: set a thumbnail from a local image (incl.
 * animated `.gif`) or generate a fresh gradient from the current theme. Closes on
 * outside mousedown or Escape (mirrors the sidebar's project context menu).
 */
function ProjectCardMenu({
  menu,
  onClose,
  onSetThumbnail,
  onGenerateGradient,
  onEditProject,
}: {
  menu: { x: number; y: number } | null
  onClose: () => void
  onSetThumbnail: () => void
  onGenerateGradient: () => void
  onEditProject: () => void
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menu) return
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("mousedown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("mousedown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [menu, onClose])

  if (!menu) return null
  return (
    <div
      ref={rootRef}
      data-testid="project-card-menu"
      role="menu"
      className="fixed z-50 w-56 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
      style={{ left: menu.x, top: menu.y }}
    >
      <button
        type="button"
        role="menuitem"
        data-testid="project-card-menu-thumbnail"
        onClick={onSetThumbnail}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60"
      >
        <ImagePlus className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">Set thumbnail…</span>
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid="project-card-menu-gradient"
        onClick={onGenerateGradient}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60"
      >
        <Sparkles className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">Generate new gradient</span>
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid="project-card-menu-edit"
        onClick={onEditProject}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60"
      >
        <Pencil className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">Edit project…</span>
      </button>
    </div>
  )
}
