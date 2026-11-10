import type { AgentSessionOrigin } from "@pi-lab/local-db"
import { cn } from "@pi-lab/ui"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Check, ChevronDown, ChevronRight, FlaskConical, Plus, Waypoints } from "lucide-react"
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react"
import { useTranslate } from "../../i18n/language"
import { type HeaderShortcutsView, useHeaderShortcuts } from "../../preferences/preferences"
import { useTRPC } from "../../trpc/react"

/** One of a view's own top bar buttons that the "+" menu can add or remove. */
export interface BuiltinShortcut {
  /** Saved id (see `DEFAULT_HEADER_SHORTCUTS`). */
  id: string
  /** Menu label, already translated. */
  label: string
  /** The button itself, rendered by the view so its launch state stays there. */
  node: ReactNode
}

/** A skill session a top bar button started, for the view to open as a tab. */
export interface StartedSkillSession {
  sessionId: string
  agentId: string
  label: string
  kind: "branch" | "worktree"
}

const SKILL_PREFIX = "skill:"
const ROUTINE_PREFIX = "routine:"

/** The data-testid prefix of each view's shortcut elements. */
const TEST_ID_PREFIX: Record<HeaderShortcutsView, string> = {
  project: "project-view",
  latex: "latex",
  tasks: "tasks",
  analysis: "analysis",
}

/** What each view records as the origin of the skill agents it starts. Tasks has none of its own. */
const SKILL_ORIGIN: Record<HeaderShortcutsView, AgentSessionOrigin> = {
  project: "project",
  latex: "latex",
  tasks: "project",
  analysis: "analysis",
}

const shortcutButtonClass =
  "flex items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-50"

const menuItemClass =
  "flex h-6 w-full shrink-0 items-center gap-1.5 rounded px-1.5 text-start text-foreground text-xs outline-none hover:bg-accent focus-visible:bg-accent"

const menuNoteClass = "px-1.5 py-1 text-[11px] text-muted-foreground"

/**
 * A view's top bar shortcut buttons, led by a "+" menu that adds or removes
 * them. Each view (`view`) keeps its own list, the same for every project.
 *
 * The menu shows the view's own buttons (`builtins`, checked when added), a
 * Skills section listing the project's skills, and a Routines section listing
 * the routines. A skill button starts the project's agent with that skill
 * triggered (`sessions.startSkill`) and hands the session to
 * `onSkillSessionStarted`, so the view opens it in its own session panel; with
 * no project (`projectId` null, Tasks "All projects") skill buttons are
 * disabled and ask to pick a project. A routine button runs the routine now
 * (`automations.runNow`) and opens that run on the Routines page. Launch
 * failures go to `onError` (null clears it).
 */
export function HeaderShortcuts({
  view,
  projectId,
  builtins,
  onSkillSessionStarted,
  onError,
}: {
  view: HeaderShortcutsView
  projectId: string | null
  builtins: BuiltinShortcut[]
  onSkillSessionStarted: (session: StartedSkillSession) => void
  onError: (message: string | null) => void
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const navigate = useNavigate()
  const [shortcuts, setShortcuts] = useHeaderShortcuts(view)
  const [open, setOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [routinesOpen, setRoutinesOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const testId = TEST_ID_PREFIX[view]

  const hasSkill = shortcuts.some((id) => id.startsWith(SKILL_PREFIX))
  const hasRoutine = shortcuts.some((id) => id.startsWith(ROUTINE_PREFIX))
  const skillsQuery = useQuery({
    ...trpc.science.skills.list.queryOptions({ projectId: projectId ?? "" }),
    enabled: projectId !== null && (open || hasSkill),
  })
  const routinesQuery = useQuery({
    ...trpc.automations.list.queryOptions(),
    enabled: open || hasRoutine,
  })
  const startSkill = useMutation(trpc.sessions.startSkill.mutationOptions())
  const runRoutine = useMutation(trpc.automations.runNow.mutationOptions())

  // The same skill can sit in several folders; the project's copy is listed first.
  const skills = (skillsQuery.data?.skills ?? []).filter(
    (skill, index, all) => all.findIndex((other) => other.slug === skill.slug) === index,
  )
  const routines = routinesQuery.data ?? []

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("mousedown", onPointerDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("mousedown", onPointerDown)
    }
  }, [open])

  const toggle = (id: string) =>
    setShortcuts(
      shortcuts.includes(id) ? shortcuts.filter((entry) => entry !== id) : [...shortcuts, id],
    )

  const onSkill = (slug: string) => {
    if (projectId === null) return
    onError(null)
    startSkill.mutate(
      { projectId, skillSlug: slug, origin: SKILL_ORIGIN[view] },
      {
        onSuccess: (result) =>
          onSkillSessionStarted({
            sessionId: result.sessionId,
            agentId: result.agentId,
            label: result.label,
            kind: result.kind,
          }),
        onError: (error) => onError(error.message),
      },
    )
  }

  const onRoutine = (automationId: string) => {
    onError(null)
    runRoutine.mutate(
      { id: automationId },
      {
        onSuccess: (result) =>
          void navigate({
            to: "/automations",
            search: result.runId
              ? {
                  notificationId: `header-shortcut-${result.runId}`,
                  notificationWorkflowId: automationId,
                  notificationRunId: result.runId,
                }
              : {},
          }),
        onError: (error) => onError(error.message),
      },
    )
  }

  const renderShortcut = (id: string): ReactNode => {
    const builtin = builtins.find((entry) => entry.id === id)
    if (builtin) return <Fragment key={id}>{builtin.node}</Fragment>
    if (id.startsWith(SKILL_PREFIX)) {
      const slug = id.slice(SKILL_PREFIX.length)
      const skill = skills.find((entry) => entry.slug === slug)
      const missing = skillsQuery.isSuccess && !skill
      const reason =
        projectId === null
          ? t("Pick a project")
          : skillsQuery.isError
            ? `${t("Could not read skills:")} ${skillsQuery.error.message}`
            : missing
              ? `${t("This project has no skill named")} ${slug}`
              : `${t("Start an agent with the skill")} ${skill?.name ?? slug}`
      return (
        <button
          key={id}
          type="button"
          data-testid={`${testId}-shortcut-skill-${slug}`}
          title={reason}
          aria-busy={startSkill.isPending}
          disabled={projectId === null || !skill || startSkill.isPending}
          onClick={() => onSkill(slug)}
          className={shortcutButtonClass}
        >
          <FlaskConical className="size-3.5 shrink-0" aria-hidden />
          <span>{skill?.name ?? slug}</span>
        </button>
      )
    }
    if (id.startsWith(ROUTINE_PREFIX)) {
      const automationId = id.slice(ROUTINE_PREFIX.length)
      const routine = routines.find((entry) => entry.id === automationId)
      const missing = routinesQuery.isSuccess && !routine
      const reason = routinesQuery.isError
        ? `${t("Could not read routines:")} ${routinesQuery.error.message}`
        : missing
          ? t("This routine no longer exists")
          : `${t("Run the routine now:")} ${routine?.name ?? ""}`
      return (
        <button
          key={id}
          type="button"
          data-testid={`${testId}-shortcut-routine-${automationId}`}
          title={reason}
          aria-busy={runRoutine.isPending}
          disabled={!routine || runRoutine.isPending}
          onClick={() => onRoutine(automationId)}
          className={shortcutButtonClass}
        >
          <Waypoints className="size-3.5 shrink-0" aria-hidden />
          <span>{routine?.name ?? t("Routine")}</span>
        </button>
      )
    }
    return null
  }

  const checkItem = (id: string, label: string) => {
    const added = shortcuts.includes(id)
    return (
      <button
        key={id}
        type="button"
        role="menuitemcheckbox"
        aria-checked={added}
        onClick={() => toggle(id)}
        className={menuItemClass}
      >
        <Check className={cn("size-3 shrink-0", added ? "" : "invisible")} aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
      </button>
    )
  }

  const sectionToggle = (label: string, expanded: boolean, onToggle: () => void) => (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className={cn(menuItemClass, "text-muted-foreground")}
    >
      {expanded ? (
        <ChevronDown className="size-3 shrink-0" aria-hidden />
      ) : (
        <ChevronRight className="size-3 shrink-0" aria-hidden />
      )}
      <span>{label}</span>
    </button>
  )

  const skillsSection = (): ReactNode => {
    if (projectId === null)
      return <p className={menuNoteClass}>{t("Pick a project to list its skills")}</p>
    if (skillsQuery.isError) {
      return (
        <p role="alert" className={cn(menuNoteClass, "text-destructive")}>
          {t("Could not read skills:")} {skillsQuery.error.message}
        </p>
      )
    }
    if (skillsQuery.isPending) return <p className={menuNoteClass}>{t("Loading…")}</p>
    if (skills.length === 0) return <p className={menuNoteClass}>{t("No skills found")}</p>
    return skills.map((skill) => checkItem(`${SKILL_PREFIX}${skill.slug}`, skill.name))
  }

  return (
    <>
      <div ref={rootRef} data-testid={`${testId}-shortcuts`} className="relative flex">
        <button
          type="button"
          data-testid={`${testId}-shortcuts-add`}
          aria-label={t("Add or remove header shortcuts")}
          title={t("Add or remove header shortcuts")}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-accent/60"
        >
          <Plus className="size-3.5 shrink-0" aria-hidden />
        </button>
        {open ? (
          <div
            role="menu"
            aria-label={t("Header shortcuts")}
            className="absolute top-full right-0 z-40 mt-1 flex max-h-80 w-52 flex-col overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground text-xs shadow-lg"
          >
            {builtins.length > 0 ? (
              <>
                {builtins.map((entry) => checkItem(entry.id, entry.label))}
                <div className="my-1 shrink-0 border-border border-t" />
              </>
            ) : null}
            {sectionToggle(t("Skills"), skillsOpen, () => setSkillsOpen(!skillsOpen))}
            {skillsOpen ? <div className="flex flex-col pl-3">{skillsSection()}</div> : null}
            {sectionToggle(t("Routines"), routinesOpen, () => setRoutinesOpen(!routinesOpen))}
            {routinesOpen ? (
              <div className="flex flex-col pl-3">
                {routinesQuery.isError ? (
                  <p role="alert" className={cn(menuNoteClass, "text-destructive")}>
                    {t("Could not read routines:")} {routinesQuery.error.message}
                  </p>
                ) : routinesQuery.isPending ? (
                  <p className={menuNoteClass}>{t("Loading…")}</p>
                ) : routines.length === 0 ? (
                  <p className={menuNoteClass}>{t("No routines yet")}</p>
                ) : (
                  routines.map((routine) =>
                    checkItem(`${ROUTINE_PREFIX}${routine.id}`, routine.name),
                  )
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {shortcuts.map(renderShortcut)}
    </>
  )
}
