import { Badge, Input } from "@skipper/ui"
import { useQuery } from "@tanstack/react-query"
import { FlaskConical, Search } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useTRPC } from "../../../../../trpc/react"
import { ScienceTabShell } from "../ScienceTabShell"

/**
 * Skills science tab (AGENTS.md §1 "Science tabs") — a **read-only catalog**:
 * pick a project, then browse the agent skills declared in its repo. Each skill
 * is a `<dir>/SKILL.md` discovered under the repo's `.claude/skills` /
 * `.agents/skills` directories (see `science.skills.list`) and shown as a card
 * with its name, description, and a badge for the source directory. Triggering a
 * skill from here is a later (v2) concern and is intentionally absent.
 *
 * The project defaults to the most-recently-opened (`projects.list` is ordered
 * that way), with a selector to switch. A client-side search narrows the list;
 * the body owns its own scroll per §12.3.
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
  const skills = skillsQuery.data ?? []

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return skills
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle) ||
        skill.slug.toLowerCase().includes(needle),
    )
  }, [skills, query])

  const selector =
    projects.length > 0 ? (
      <select
        data-testid="skills-project-select"
        value={selectedId ?? ""}
        onChange={(event) => setSelectedId(event.target.value)}
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
      subtitle="Browse the agent skills declared in a project's repo"
      actions={selector}
    >
      <div className="flex shrink-0 items-center border-border border-b px-6 py-2">
        <div className="relative w-full max-w-sm">
          <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
          <Input
            data-testid="skills-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills…"
            className="h-8 pl-8"
            disabled={skills.length === 0}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 p-6">
          {projects.length === 0 ? (
            <NoProjectsState />
          ) : skills.length === 0 && !skillsQuery.isLoading ? (
            <EmptyState />
          ) : (
            <>
              <div
                data-testid="skills-count"
                className="font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
              >
                {filtered.length} of {skills.length} skills
              </div>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {filtered.map((skill) => (
                  <SkillCard key={`${skill.source}:${skill.slug}`} skill={skill} />
                ))}
              </div>
              {filtered.length === 0 && skills.length > 0 ? (
                <p data-testid="skills-no-matches" className="text-muted-foreground text-xs">
                  No skills match “{query}”.
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </ScienceTabShell>
  )
}

/** A single skill, rendered as a card (name, source badge, description). */
function SkillCard({
  skill,
}: {
  skill: { name: string; description: string; slug: string; source: string; path: string }
}) {
  return (
    <div
      data-testid="skill-card"
      data-skill={skill.slug}
      className="flex flex-col gap-1.5 rounded-lg border border-border bg-card/40 p-3"
    >
      <div className="flex items-center gap-2">
        <FlaskConical className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span data-testid="skill-name" className="min-w-0 flex-1 truncate font-medium text-sm">
          {skill.name}
        </span>
        <Badge data-testid="skill-source" variant="muted" className="font-mono">
          {skill.source}
        </Badge>
      </div>
      {skill.description ? (
        <p className="text-muted-foreground text-xs leading-relaxed">{skill.description}</p>
      ) : null}
    </div>
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

/** Shown when the selected project has no skills declared. */
function EmptyState() {
  return (
    <div
      data-testid="science-skills-empty"
      className="flex flex-col items-center gap-3 rounded-lg border border-border border-dashed p-12 text-center"
    >
      <FlaskConical className="size-8 text-muted-foreground" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="font-medium text-foreground text-sm">No skills found</p>
        <p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
          Skills are discovered from <code className="font-mono">.claude/skills/*/SKILL.md</code>{" "}
          and <code className="font-mono">.agents/skills/*/SKILL.md</code> in the selected project's
          repo.
        </p>
      </div>
    </div>
  )
}
