import { useQuery } from "@tanstack/react-query"
import {
  SkillCard,
  SkillRootWarnings,
  SkillScopeControls,
  SkillsMessage,
  skillKey,
  useSkillScopeVisibility,
  useVisibleSkills,
} from "../../../../../../../skills"
import { useTRPC } from "../../../../../../../trpc/react"

/** Optional project-context visualization of the same read-only Skills catalog. */
export function SkillsPanel({ projectId }: { projectId: string }) {
  const trpc = useTRPC()
  const catalogQuery = useQuery(
    trpc.science.skills.list.queryOptions({ projectId }, { staleTime: 60_000 }),
  )
  const visibility = useSkillScopeVisibility()
  const skills = catalogQuery.data?.skills ?? []
  const visibleSkills = useVisibleSkills(skills, visibility)

  return (
    <section data-testid="panel-skills" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-border border-b px-3 py-2">
        <div>
          <h2 className="font-medium text-xs">Skills</h2>
          <p className="text-[11px] text-muted-foreground">Project-local first, then global</p>
        </div>
        <SkillScopeControls visibility={visibility} testIdPrefix="panel-skills" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {catalogQuery.isError ? (
          <SkillsMessage
            testId="panel-skills-error"
            title="Skills could not be indexed"
            detail={catalogQuery.error.message}
            destructive={true}
          />
        ) : catalogQuery.isLoading ? (
          <SkillsMessage
            testId="panel-skills-loading"
            title="Indexing skills…"
            detail="Reading project-local and global skill locations."
            destructive={false}
          />
        ) : skills.length === 0 ? (
          <SkillsMessage
            testId="panel-skills-empty"
            title="No skills found"
            detail="No SKILL.md files were found in the six conventional locations."
            destructive={false}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <SkillRootWarnings roots={catalogQuery.data?.roots ?? []} testIdPrefix="panel-skills" />
            {visibleSkills.length === 0 ? (
              <p
                data-testid="panel-skills-hidden"
                className="text-center text-muted-foreground text-xs"
              >
                No skills are visible in these scopes.
              </p>
            ) : (
              visibleSkills.map((skill) => (
                <SkillCard key={skillKey(skill)} skill={skill} selected={false} />
              ))
            )}
          </div>
        )}
      </div>
    </section>
  )
}
