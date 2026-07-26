import type { Project, ProjectMetadata } from "@pi-lab/local-db"
import { cn } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import {
  BookOpen,
  CalendarClock,
  Eye,
  EyeOff,
  FlaskConical,
  ImagePlus,
  Link2,
  Pencil,
  Sparkles,
  Users,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { ProjectWorkflowControl } from "../../../../../components/ProjectWorkflow"
import {
  readFetchExperimentsInstructions,
  useDigitalRainDensity,
  useDigitalRainSpeed,
} from "../../../../../preferences/preferences"
import { useTRPC } from "../../../../../trpc/react"
import { setPendingLaunch } from "../../../projects/-pendingLaunch"
import { deriveProjectState, type ProjectState } from "../../utils/deriveProjectState"
import { hashString, projectGradient, sampleThemePalette } from "../../utils/projectGradient"
import { DigitalRainThumbnail } from "./DigitalRainThumbnail"
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
 *     header's **Set thumbnail** action opens an artwork chooser: pick a local
 *     image (including animated `.gif`), generate a fresh gradient from the
 *     current app theme, or create a Digital Rain canvas. Dropping an image also
 *     sets the thumbnail. Each artwork kind replaces the others (enforced
 *     server-side). A project with none yet captures a default gradient from the
 *     current theme on first render and persists it, so it stays fixed thereafter.
 *   - an **info area** — the project name and a status badge from
 *     `deriveProjectState`, with live agent activity determining whether the status
 *     is empty, working, or paused. An `active` project's gradient also drifts as a
 *     live activity cue.
 *
 * Clicking the card opens the project's route; right-clicking anywhere on it
 * opens the project menu at the pointer.
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
// Activity is a tiny, shared read. Keep dashboard status badges and artwork cues
// synchronized with the monitor without creating a per-frame renderer workload.
const ACTIVITY_REFRESH_MS = 1_000

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
  const [choosingArtwork, setChoosingArtwork] = useState(false)
  const [editing, setEditing] = useState(false)
  const [digitalRainDensity] = useDigitalRainDensity()
  const [digitalRainSpeed] = useDigitalRainSpeed()
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const activityQuery = useQuery(
    trpc.sessions.activity.queryOptions(undefined, { refetchInterval: ACTIVITY_REFRESH_MS }),
  )
  const capabilitiesQuery = useQuery(trpc.projects.capabilities.queryOptions({ id: project.id }))
  const gitAvailable =
    !capabilitiesQuery.isError && (capabilitiesQuery.data?.git ?? project.defaultBranch !== null)
  const gitDisabledReason = capabilitiesQuery.isError
    ? `Could not check Git availability: ${capabilitiesQuery.error.message}`
    : "Initialize Git to use this Git-backed action."
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
  const setDigitalRain = useMutation(
    trpc.projects.setDigitalRain.mutationOptions({ onSuccess: invalidateProjects }),
  )
  const setMetadata = useMutation(
    trpc.projects.setMetadata.mutationOptions({ onSuccess: invalidateProjects }),
  )
  const setArchived = useMutation(
    trpc.projects.setArchived.mutationOptions({ onSuccess: invalidateProjects }),
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
    if (!gitAvailable) return
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
  const needsDefaultGradient = !project.digitalRain && !project.thumbnail && !project.gradient
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
    setGradient.mutate({
      id: project.id,
      gradient: { seed: Math.floor(Math.random() * 0x1_0000_0000), palette: sampleThemePalette() },
    })
  }

  const openFilePicker = () => {
    fileInputRef.current?.click()
  }

  const openArtworkChooser = () => {
    setMenu(null)
    setChoosingArtwork(true)
  }

  const chooseArtworkFile = () => {
    setChoosingArtwork(false)
    openFilePicker()
  }

  const chooseGradient = () => {
    setChoosingArtwork(false)
    generateGradient()
  }

  const chooseDigitalRain = () => {
    setChoosingArtwork(false)
    setDigitalRain.mutate({ id: project.id, enabled: true })
  }

  const digitalRainCharactersQuery = useQuery({
    ...trpc.projects.digitalRainCharacters.queryOptions({ id: project.id }),
    enabled: project.digitalRain,
  })

  const openEditDialog = () => {
    setMenu(null)
    setEditing(true)
  }

  const saveMetadata = (metadata: ProjectMetadata | null) => {
    setEditing(false)
    setMetadata.mutate({ id: project.id, metadata })
  }

  const setProjectHidden = () => {
    setMenu(null)
    setArchived.mutate({ id: project.id, archived: !project.archivedAt })
  }

  // The animated gradient layer (no-thumbnail header only). The play-state hook
  // pauses drift unless the project is active and the card is on-screen/focused,
  // toggling `animation-play-state` directly (no re-render).
  const gradientRef = useRef<HTMLDivElement | null>(null)
  useGradientPlayState(gradientRef, state === "active")

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the card's nested title button remains the keyboard-accessible open control; right-clicking anywhere on this visual card exposes its pointer-positioned menu without adding a duplicate tab stop.
    <div
      data-testid="project-card"
      data-project-id={project.id}
      data-state={state}
      data-hidden={Boolean(project.archivedAt)}
      className={cn(
        "group flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card text-left",
        isDragOver && "border-brand ring-2 ring-brand/40",
        project.archivedAt && "opacity-60 saturate-50",
      )}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
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
       * the thumbnail; right-clicking anywhere on the card opens its menu.
       */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop and right-click have no keyboard equivalent and no single semantic element; this region is a visual drop target that also opens the project on click, mirroring the keyboard-reachable info button. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the click only mirrors the info button's navigation, which is the real keyboard-activable control; a key handler / extra tab stop here would be a redundant duplicate target. */}
      <div
        data-testid="project-card-image"
        className="relative isolate h-32 w-full shrink-0 overflow-hidden transition-[filter] group-hover:brightness-105 group-hover:contrast-105 group-hover:saturate-125"
        style={
          project.thumbnail
            ? undefined
            : { backgroundColor: project.digitalRain ? "#000" : "var(--muted)" }
        }
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
        ) : project.digitalRain ? (
          <>
            <DigitalRainThumbnail
              characters={digitalRainCharactersQuery.data?.characters}
              density={digitalRainDensity}
              speed={digitalRainSpeed}
              animate={state === "active"}
            />
            {/* Black and white pixels are already at the limits of CSS contrast,
                so this subtle exposure layer makes the shared card-hover cue
                visibly perceptible on a Digital Rain thumbnail too. */}
            <div
              data-testid="project-card-digital-rain-hover"
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-white/0 transition-colors group-hover:bg-white/[0.06]"
            />
          </>
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

      {/* The entire flexible card body above the action divider opens the project.
          The title remains a real button for keyboard access; reference links
          preserve their own navigation instead of bubbling into the project. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the nested title button is the keyboard-accessible target, and the container extends its click area into the otherwise inert flexible space. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation comes from the nested title button; adding a second focus target would duplicate it. */}
      <div
        data-testid="project-card-body"
        className="flex min-h-0 flex-1 flex-col transition-[filter] group-hover:brightness-105"
        onClick={(event) => {
          if ((event.target as Element).closest("a")) return
          openProject()
        }}
      >
        <button
          type="button"
          data-testid="project-card-open"
          data-feature-label={project.name}
          data-feature-help={`Open the ${project.name} project workspace; right-click anywhere on the card to set a thumbnail or generate a new gradient`}
          className="flex flex-col items-start gap-1.5 p-3 text-left outline-none transition-colors focus-visible:bg-accent/40"
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
      </div>

      {/* Card actions pinned to the bottom: launch a placeholder auto-research
          session in an isolated worktree (interactive), plus the two stateful
          background workflow controls — "Fetch remote experiments" and "Project
          summary" — which run headlessly, cache their result per git-state, and
          open a result popup when done. See md/02 — Dashboard & project cards. */}
      <div
        data-testid="project-card-actions"
        className="mt-auto flex items-center gap-1.5 border-border border-t p-2 transition-[filter] group-hover:brightness-105"
      >
        <button
          type="button"
          data-testid="project-card-auto-research"
          aria-label={`Auto-research ${project.name}`}
          title={gitAvailable ? "Auto-research" : gitDisabledReason}
          data-feature-label={`Auto-research ${project.name}`}
          data-feature-help={
            gitAvailable
              ? `Open an isolated worktree agent session for ${project.name} and seed a placeholder AUTORESEARCH.md`
              : gitDisabledReason
          }
          disabled={!gitAvailable}
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
          disabled={!gitAvailable}
          disabledReason={gitAvailable ? undefined : gitDisabledReason}
        />
        <ProjectWorkflowControl
          projectId={project.id}
          projectName={project.name}
          task="summary"
          variant="compact"
          testId="project-card-summary"
          disabled={!gitAvailable}
          disabledReason={gitAvailable ? undefined : gitDisabledReason}
        />
      </div>

      <ProjectCardMenu
        menu={menu}
        onClose={() => setMenu(null)}
        onSetThumbnail={openArtworkChooser}
        onEditProject={openEditDialog}
        hidden={Boolean(project.archivedAt)}
        onSetHidden={setProjectHidden}
      />

      {choosingArtwork ? (
        <ProjectCardArtworkDialog
          onClose={() => setChoosingArtwork(false)}
          onChooseFile={chooseArtworkFile}
          onGenerateGradient={chooseGradient}
          onChooseDigitalRain={chooseDigitalRain}
        />
      ) : null}

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
 * The right-click menu for a project card, positioned at the cursor. Its
 * artwork action opens the chooser for a local image (including animated `.gif`)
 * or a fresh theme-sampled gradient. Closes on outside mousedown or Escape
 * (mirrors the sidebar's project context menu).
 */
function ProjectCardMenu({
  menu,
  onClose,
  onSetThumbnail,
  onEditProject,
  hidden,
  onSetHidden,
}: {
  menu: { x: number; y: number } | null
  onClose: () => void
  onSetThumbnail: () => void
  onEditProject: () => void
  hidden: boolean
  onSetHidden: () => void
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
        data-testid="project-card-menu-edit"
        onClick={onEditProject}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60"
      >
        <Pencil className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">Edit project…</span>
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid={hidden ? "project-card-menu-restore" : "project-card-menu-hide"}
        onClick={onSetHidden}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60"
      >
        {hidden ? (
          <Eye className="size-4 shrink-0" aria-hidden />
        ) : (
          <EyeOff className="size-4 shrink-0" aria-hidden />
        )}
        <span className="min-w-0 truncate">{hidden ? "Unhide project" : "Hide project"}</span>
      </button>
    </div>
  )
}

function ProjectCardArtworkDialog({
  onClose,
  onChooseFile,
  onGenerateGradient,
  onChooseDigitalRain,
}: {
  onClose: () => void
  onChooseFile: () => void
  onGenerateGradient: () => void
  onChooseDigitalRain: () => void
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a click-to-dismiss surface; Escape and the Cancel button provide keyboard-accessible dismissal.
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismissal mirrors Escape, which is already handled by the dialog.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label="Set thumbnail"
        data-testid="project-card-artwork-dialog"
        className="w-full max-w-sm rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xl"
      >
        <h2 className="font-medium text-foreground text-sm">Set thumbnail</h2>
        <p className="mt-1 text-muted-foreground text-xs">
          Choose an image file, a new project gradient, or ASCII Digital Rain.
        </p>
        <div className="mt-4 grid gap-2">
          <button
            type="button"
            data-testid="project-card-artwork-file"
            onClick={onChooseFile}
            className="flex items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <ImagePlus className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium text-sm">Choose image file</span>
              <span className="text-muted-foreground text-xs">Use an image or animated GIF.</span>
            </span>
          </button>
          <button
            type="button"
            data-testid="project-card-artwork-gradient"
            onClick={onGenerateGradient}
            className="flex items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <Sparkles className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium text-sm">Generate new gradient</span>
              <span className="text-muted-foreground text-xs">
                Create a new theme-sampled gradient.
              </span>
            </span>
          </button>
          <button
            type="button"
            data-testid="project-card-artwork-digital-rain"
            onClick={onChooseDigitalRain}
            className="flex items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <span
              className="flex size-5 shrink-0 items-center justify-center rounded bg-black font-mono text-[10px] text-white"
              aria-hidden
            >
              01
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium text-sm">Digital Rain</span>
              <span className="text-muted-foreground text-xs">
                Animate ASCII sampled from this project&apos;s files.
              </span>
            </span>
          </button>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            data-testid="project-card-artwork-cancel"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
