import type { ProjectDetails, ProjectMetadata } from "@pi-lab/local-db"
import { cn } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import {
  CalendarClock,
  ChartArea,
  Eye,
  EyeOff,
  ImagePlus,
  Pencil,
  Sparkles,
  Telescope,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { ProjectWorkflowControl } from "../../../../../components/ProjectWorkflow"
import { useInterfaceLanguage, useTranslate } from "../../../../../i18n/language"
import {
  useDigitalRainDensity,
  useDigitalRainSpeed,
  useShowAnalysisSection,
} from "../../../../../preferences/preferences"
import { useTRPC } from "../../../../../trpc/react"
import { type ProjectSummary, useProjectThumbnail } from "../../../../../trpc/useProjectThumbnail"
import { useProjectActivityState } from "../../../-ProjectActivity"
import { setPendingLaunch } from "../../../projects/-pendingLaunch"
import type { ProjectState } from "../../utils/deriveProjectState"
import { hashString, projectGradient, sampleThemePalette } from "../../utils/projectGradient"
import { DigitalRainThumbnail } from "./DigitalRainThumbnail"
import { EditProjectDialog } from "./EditProjectDialog"
import { useGradientPlayState } from "./hooks/useGradientPlayState"
import { readImageFileAsDataUrl } from "./utils/readImageFileAsDataUrl"

/**
 * A single dashboard project card. Two stacked regions:
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
 *   - an **info area** — the project name and a status badge from shared live
 *     agent activity. The status is idle, working, or paused. An `active`
 *     project's gradient also drifts as a live activity cue.
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

// Compact, icon-forward card-action button — modeled on the Caffeine title-bar
// control (small, subtle, bordered, `text-xs`). Icon-only so all three actions fit
// on one row without wrapping; discoverability comes from the per-button
// `data-feature-label` / `data-feature-help` hover-help and the native `title`.
const CARD_ACTION_CLASS =
  "inline-flex h-7 flex-1 items-center justify-center rounded-md border border-border text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-60"

interface ProjectCardProps {
  project: ProjectSummary
}

export function ProjectCard({ project }: ProjectCardProps) {
  const t = useTranslate()
  const trpc = useTRPC()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [isDragOver, setIsDragOver] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [choosingArtwork, setChoosingArtwork] = useState(false)
  const [editing, setEditing] = useState(false)
  const [showAnalysis] = useShowAnalysisSection()
  const [digitalRainDensity] = useDigitalRainDensity()
  const [digitalRainSpeed] = useDigitalRainSpeed()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const artworkGenerationRef = useRef(0)
  const thumbnail = useProjectThumbnail(project, "card")

  const state = useProjectActivityState(project.id)
  const capabilitiesQuery = useQuery(trpc.projects.capabilities.queryOptions({ id: project.id }))
  const gitAvailable =
    !capabilitiesQuery.isError && (capabilitiesQuery.data?.git ?? project.defaultBranch !== null)
  const gitDisabledReason = capabilitiesQuery.isError
    ? `${t("Could not check Git availability:")} ${capabilitiesQuery.error.message}`
    : t("Initialize Git to use this Git-backed action.")

  const invalidateProjects = () => {
    setActionError(null)
    void queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.projects.thumbnail.pathKey() })
  }
  const reportMutationError = (error: { message: string }) => setActionError(error.message)

  const setThumbnail = useMutation(
    trpc.projects.setThumbnail.mutationOptions({
      onSuccess: invalidateProjects,
      onError: reportMutationError,
    }),
  )
  const setGradient = useMutation(
    trpc.projects.setGradient.mutationOptions({
      onSuccess: invalidateProjects,
      onError: reportMutationError,
    }),
  )
  const setDigitalRain = useMutation(
    trpc.projects.setDigitalRain.mutationOptions({
      onSuccess: invalidateProjects,
      onError: reportMutationError,
    }),
  )
  const updateDetails = useMutation(
    trpc.projects.updateDetails.mutationOptions({
      onSuccess: () => {
        setEditing(false)
        invalidateProjects()
        void queryClient.invalidateQueries({
          queryKey: trpc.agents.projectChoice.queryKey({ projectId: project.id }),
        })
      },
      onError: reportMutationError,
    }),
  )
  const setArchived = useMutation(
    trpc.projects.setArchived.mutationOptions({
      onSuccess: invalidateProjects,
      onError: reportMutationError,
    }),
  )

  const openProject = () => {
    void navigate({ to: "/projects/$projectId", params: { projectId: project.id } })
  }

  // Auto-research: record the launch intent and open the project **immediately** —
  // the project view picks the intent up on mount, runs the launch itself, and
  // attaches the returned session to its central panel (a failed launch surfaces
  // there). Navigating first means opening the project never waits on — nor gets
  // wedged by — the launch RPC.
  const onAutoResearch = () => {
    if (!gitAvailable) return
    setPendingLaunch(project.id, { kind: "auto-research" })
    openProject()
  }

  const applyThumbnailFile = async (file: File | undefined) => {
    if (!file?.type.startsWith("image/")) return
    const generation = ++artworkGenerationRef.current
    setActionError(null)
    try {
      const dataUrl = await readImageFileAsDataUrl(file)
      if (generation !== artworkGenerationRef.current) return
      await setThumbnail.mutateAsync({ id: project.id, dataUrl })
    } catch (error) {
      if (generation === artworkGenerationRef.current) {
        setActionError(error instanceof Error ? error.message : t("Could not set this thumbnail."))
      }
    }
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
  const needsDefaultGradient = !project.digitalRain && !thumbnail.hasThumbnail && !project.gradient
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
    artworkGenerationRef.current += 1
    setActionError(null)
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
    artworkGenerationRef.current += 1
    setActionError(null)
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

  const saveDetails = (details: ProjectDetails) => {
    updateDetails.mutate({ id: project.id, details })
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
        "group flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card text-start",
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
          thumbnail.dataUrl
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
        {thumbnail.dataUrl ? (
          <img src={thumbnail.dataUrl} alt="" className="size-full object-cover" />
        ) : project.digitalRain ? (
          <>
            {/* Wait for the project's characters (or their failure, which falls back
                to default glyphs) so the first paint is the final one. */}
            {digitalRainCharactersQuery.isFetched && (
              <DigitalRainThumbnail
                characters={digitalRainCharactersQuery.data?.characters}
                density={digitalRainDensity}
                speed={digitalRainSpeed}
                animate={state === "active"}
              />
            )}
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
            {t("Drop image to set thumbnail")}
          </div>
        ) : null}
      </div>

      {thumbnail.tooLarge ? (
        <div role="alert" className="flex items-center justify-between gap-2 px-3 py-1 text-xs">
          <span>{t("Stored thumbnail is too large to display.")}</span>
          <button
            type="button"
            className="underline"
            onClick={() => {
              artworkGenerationRef.current += 1
              setThumbnail.mutate({ id: project.id, dataUrl: null })
            }}
          >
            {t("Clear thumbnail")}
          </button>
        </div>
      ) : null}
      {actionError ? (
        <div role="alert" className="px-3 py-1 text-xs text-destructive">
          {actionError}
        </div>
      ) : null}

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
          data-feature-help={t(
            "Open this project workspace; right-click anywhere on the card to set a thumbnail or generate a new gradient",
          )}
          className="flex flex-col items-start gap-1.5 p-3 text-start outline-none transition-colors focus-visible:bg-accent/40"
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
              {t(STATUS_LABEL[state])}
            </span>
          </div>
        </button>

        {/* Show the project deadline and assigned tags below the title. */}
        {project.metadata ? <ProjectCardMetadata metadata={project.metadata} /> : null}
      </div>

      <div
        data-testid="project-card-actions"
        className="mt-auto flex items-center gap-1.5 border-border border-t p-2 transition-[filter] group-hover:brightness-105"
      >
        <button
          type="button"
          data-testid="project-card-auto-research"
          aria-label={`${t("Auto-research")} ${project.name}`}
          title={gitAvailable ? t("Auto-research") : gitDisabledReason}
          data-feature-label={`${t("Auto-research")} ${project.name}`}
          data-feature-help={
            gitAvailable
              ? t("Open an isolated worktree agent session and seed a placeholder AUTORESEARCH.md")
              : gitDisabledReason
          }
          disabled={!gitAvailable}
          onClick={onAutoResearch}
          className={CARD_ACTION_CLASS}
        >
          <Telescope className="size-4 shrink-0" aria-hidden />
        </button>
        {showAnalysis ? (
          <button
            type="button"
            data-testid="project-card-analysis"
            aria-label={`${t("Analysis")} ${project.name}`}
            title={t("Analysis")}
            data-feature-label={t("Analysis")}
            data-feature-help={t("Open this project's analysis files")}
            className={CARD_ACTION_CLASS}
            onClick={() =>
              void navigate({ to: "/science/analysis", search: { projectId: project.id } })
            }
          >
            <ChartArea className="size-4 shrink-0" aria-hidden />
          </button>
        ) : null}
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
          mode="edit"
          pending={updateDetails.isPending}
          error={updateDetails.error?.message ?? null}
          onSave={saveDetails}
        />
      ) : null}
    </div>
  )
}

/** Format an ISO `YYYY-MM-DD` deadline as a readable local date (no TZ shift). */
function formatDeadline(iso: string, language: string, due: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return iso
  const [, year, month, day] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day))
  return `${due} ${date.toLocaleDateString(language, { month: "short", day: "numeric", year: "numeric" })}`
}

/** Render the deadline and assigned tags. */
function ProjectCardMetadata({ metadata }: { metadata: ProjectMetadata }) {
  const [language] = useInterfaceLanguage()
  const t = useTranslate()
  const emojiTags = metadata.emojiTags ?? []
  const textTags = metadata.textTags ?? []
  const hasAny = Boolean(metadata.deadline) || emojiTags.length > 0 || textTags.length > 0
  if (!hasAny) return null

  return (
    <div
      data-testid="project-card-metadata"
      className="flex flex-col gap-1.5 px-3 pb-3 text-muted-foreground text-xs"
    >
      {metadata.deadline ? (
        <div data-testid="project-card-deadline" className="flex items-center gap-1.5">
          <CalendarClock className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            {formatDeadline(metadata.deadline, language, t("Due"))}
          </span>
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
      {textTags.length ? (
        <div className="flex flex-wrap gap-1.5">
          {textTags.map((tag) => (
            <span
              key={tag.label}
              data-testid="project-card-text-tag"
              className="rounded-full bg-brand/15 px-2 py-1 text-xs text-foreground"
            >
              {tag.label}
            </span>
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
  const t = useTranslate()
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
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent/60"
      >
        <ImagePlus className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{t("Set thumbnail…")}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid="project-card-menu-edit"
        onClick={onEditProject}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent/60"
      >
        <Pencil className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{t("Edit project…")}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid={hidden ? "project-card-menu-restore" : "project-card-menu-hide"}
        onClick={onSetHidden}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent/60"
      >
        {hidden ? (
          <Eye className="size-4 shrink-0" aria-hidden />
        ) : (
          <EyeOff className="size-4 shrink-0" aria-hidden />
        )}
        <span className="min-w-0 truncate">{hidden ? t("Unhide project") : t("Hide project")}</span>
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
  const t = useTranslate()
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
        aria-label={t("Set thumbnail")}
        data-testid="project-card-artwork-dialog"
        className="w-full max-w-sm rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xl"
      >
        <h2 className="font-medium text-foreground text-sm">{t("Set thumbnail")}</h2>
        <p className="mt-1 text-muted-foreground text-xs">
          {t("Choose an image file, a new project gradient, or ASCII Digital Rain.")}
        </p>
        <div className="mt-4 grid gap-2">
          <button
            type="button"
            data-testid="project-card-artwork-file"
            onClick={onChooseFile}
            className="flex items-center gap-3 rounded-lg border border-border p-3 text-start transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <ImagePlus className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium text-sm">{t("Choose image file")}</span>
              <span className="text-muted-foreground text-xs">
                {t("Use an image or animated GIF.")}
              </span>
            </span>
          </button>
          <button
            type="button"
            data-testid="project-card-artwork-gradient"
            onClick={onGenerateGradient}
            className="flex items-center gap-3 rounded-lg border border-border p-3 text-start transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <Sparkles className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium text-sm">{t("Generate new gradient")}</span>
              <span className="text-muted-foreground text-xs">
                {t("Create a new theme-sampled gradient.")}
              </span>
            </span>
          </button>
          <button
            type="button"
            data-testid="project-card-artwork-digital-rain"
            onClick={onChooseDigitalRain}
            className="flex items-center gap-3 rounded-lg border border-border p-3 text-start transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <span
              className="flex size-5 shrink-0 items-center justify-center rounded bg-black font-mono text-[10px] text-white"
              aria-hidden
            >
              01
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium text-sm">{t("Digital Rain")}</span>
              <span className="text-muted-foreground text-xs">
                {t("Animate ASCII sampled from this project's files.")}
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
            {t("Cancel")}
          </button>
        </div>
      </div>
    </div>
  )
}
