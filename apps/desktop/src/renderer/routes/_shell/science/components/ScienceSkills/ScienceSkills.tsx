import { Input } from "@pi-lab/ui"
import { useQuery } from "@tanstack/react-query"
import { FlaskConical, Search } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { QuickFind, type QuickFindItem } from "../../../../../QuickFind"
import { eventMatchesShortcut } from "../../../../../shortcuts/shortcuts"
import {
  SkillCard,
  type SkillCatalogItem,
  SkillRootWarnings,
  SkillScopeControls,
  SkillsMessage,
  skillKey,
  useSkillScopeVisibility,
  useVisibleSkills,
} from "../../../../../skills"
import { useTRPC } from "../../../../../trpc/react"
import { ScienceTabShell } from "../ScienceTabShell"

const EMPTY_SKILLS: SkillCatalogItem[] = []

/**
 * Skills science tab (AGENTS.md "Scope" "Science tabs") — a **read-only catalog**:
 * pick a project, then browse its project-local and global agent skills. Each
 * skill is a `<dir>/SKILL.md` discovered under `.claude/skills`,
 * `.codex/skills`, or `.agents/skills` in the repository or home directory (see
 * `science.skills.list`) and shown as a card with name, description, scope,
 * harness, and source labels. Triggering a skill from here is a later (v2)
 * concern and is intentionally absent.
 *
 * The project defaults to the most-recently-opened (`projects.list` is ordered
 * that way), with a selector to switch. A client-side search narrows the list;
 * the body owns its own scroll per AGENTS.md Pitfalls #3.
 *
 * Context-aware ⌘F (the quick-open shortcut): opens a {@link QuickFind} over the
 * skills currently shown in this tab (not projects — the shell skips `/science/*`,
 * so this tab is the sole ⌘F owner here). Since skills are a read-only catalog with
 * no per-item action (triggering is a v2 concern), picking one highlights and scrolls
 * its card into view.
 */
export function ScienceSkills() {
  const trpc = useTRPC()

  const projectsQuery = useQuery(trpc.projects.list.queryOptions())
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data])

  // Default to the most-recently-opened project (first in the ordered list) and
  // keep the selection valid as the project list loads / changes.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  useEffect(() => {
    if (projects.length === 0) {
      if (selectedId !== null) setSelectedId(null)
      return
    }
    if (!selectedId || !projects.some((p) => p.id === selectedId)) {
      setSelectedId(projects[0]?.id ?? null)
    }
  }, [projects, selectedId])

  const [query, setQuery] = useState("")

  const skillsQuery = useQuery({
    ...trpc.science.skills.list.queryOptions({ projectId: selectedId ?? "" }),
    enabled: selectedId !== null,
    staleTime: 60_000,
  })
  const catalog = skillsQuery.data
  const skills = catalog?.skills ?? EMPTY_SKILLS
  const visibility = useSkillScopeVisibility()
  const visibleSkills = useVisibleSkills(skills, visibility)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return visibleSkills
    return visibleSkills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle) ||
        skill.slug.toLowerCase().includes(needle),
    )
  }, [query, visibleSkills])

  // Context-aware ⌘F finder over the skills shown in this tab, plus the card it
  // highlights once a result is picked (skills have no open/trigger action — v2).
  const [findOpen, setFindOpen] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // The quick-open shortcut opens the finder; mount-once so the binding is read live.
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (eventMatchesShortcut(event, "quick-open")) {
        event.preventDefault()
        setFindOpen(true)
      }
    }
    window.addEventListener("keydown", onWindowKeyDown)
    return () => window.removeEventListener("keydown", onWindowKeyDown)
  }, [])

  // Scroll the picked card into view after the finder selects it.
  useEffect(() => {
    if (!selectedKey) return
    listRef.current
      ?.querySelector<HTMLElement>('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" })
  }, [selectedKey])

  const selector =
    projects.length > 0 ? (
      <select
        data-testid="skills-project-select"
        aria-label="Skills project"
        data-feature-label="Skills project"
        data-feature-help="Choose which project repository to inspect for agent skills."
        value={selectedId ?? ""}
        onChange={(event) => {
          setSelectedId(event.target.value)
          setSelectedKey(null) // drop a stale finder highlight when the skill list changes
        }}
        className="h-8 rounded-md border border-border bg-background px-2 text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-ring"
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    ) : null

  return (
    <ScienceTabShell
      testId="science-skills"
      title="Skills"
      subtitle="Browse project-local and global agent skills"
      actions={selector}
    >
      <div className="flex shrink-0 items-center gap-3 border-border border-b px-6 py-2">
        <div className="relative w-full max-w-sm">
          <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
          <Input
            data-testid="skills-search"
            aria-label="Search skills"
            data-feature-label="Search skills"
            data-feature-help="Filter the selected project's declared agent skills by name or description."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills…"
            className="h-8 pl-8"
            disabled={skills.length === 0}
          />
        </div>
        <SkillScopeControls visibility={visibility} testIdPrefix="skills" />
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 p-6">
          {projects.length === 0 ? (
            <NoProjectsState />
          ) : skillsQuery.isError ? (
            <SkillsMessage
              testId="science-skills-error"
              title="Skills could not be indexed"
              detail={skillsQuery.error.message}
              destructive={true}
            />
          ) : skillsQuery.isLoading ? (
            <SkillsMessage
              testId="science-skills-loading"
              title="Indexing skills…"
              detail="Reading the conventional project-local and global skill locations."
              destructive={false}
            />
          ) : skills.length === 0 ? (
            <SkillsMessage
              testId="science-skills-empty"
              title="No skills found"
              detail="PI Lab checked .claude/skills, .codex/skills, and .agents/skills in this project and in your home directory."
              destructive={false}
            />
          ) : (
            <>
              <SkillRootWarnings roots={catalog?.roots ?? []} testIdPrefix="science-skills" />
              <div
                data-testid="skills-count"
                className="font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
              >
                {filtered.length} of {skills.length} skills
              </div>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {filtered.map((skill) => {
                  const key = skillKey(skill)
                  return <SkillCard key={key} skill={skill} selected={key === selectedKey} />
                })}
              </div>
              {filtered.length === 0 && skills.length > 0 ? (
                <p data-testid="skills-no-matches" className="text-muted-foreground text-xs">
                  {query ? `No skills match “${query}”.` : "No skills are visible in these scopes."}
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>

      {findOpen ? (
        <QuickFind
          ariaLabel="Find a skill"
          placeholder="Find a skill…"
          // The skills currently shown in this tab (narrowed by the search box, if any).
          items={filtered.map(
            (skill): QuickFindItem => ({
              id: skillKey(skill),
              label: skill.name,
              hint: `${skill.scope === "project" ? "Project-local" : "Global"} · ${skill.source}`,
              icon: FlaskConical,
            }),
          )}
          emptyText="No matching skills"
          // No open/trigger action for a skill yet (v2) — highlight + scroll its card.
          onSelect={(item) => setSelectedKey(item.id)}
          onClose={() => setFindOpen(false)}
        />
      ) : null}
    </ScienceTabShell>
  )
}

/** Shown when no project is open at all (nothing to scan for skills). */
function NoProjectsState() {
  return (
    <div
      data-testid="science-skills-no-projects"
      className="flex flex-col items-center gap-3 rounded-lg border border-border border-dashed p-12 text-center"
    >
      <FlaskConical className="size-8 text-muted-foreground" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="font-medium text-foreground text-sm">No projects open</p>
        <p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
          Open a project from the sidebar to browse the skills declared in its repo.
        </p>
      </div>
    </div>
  )
}
