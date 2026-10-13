import { Badge, cn } from "@pi-lab/ui"
import { FlaskConical } from "lucide-react"
import { useTranslate } from "../i18n/language"
import { useShowGlobalSkills, useShowProjectSkills } from "../preferences/preferences"
import type { RouterOutputs } from "../trpc/types"

export type SkillsCatalog = RouterOutputs["science"]["skills"]["list"]
export type SkillCatalogItem = SkillsCatalog["skills"][number]
export type SkillCatalogRoot = SkillsCatalog["roots"][number]

export interface SkillScopeVisibility {
  showProject: boolean
  showGlobal: boolean
  setShowProject: (next: boolean) => void
  setShowGlobal: (next: boolean) => void
}

export function useSkillScopeVisibility(): SkillScopeVisibility {
  const [showProject, setShowProject] = useShowProjectSkills()
  const [showGlobal, setShowGlobal] = useShowGlobalSkills()
  return { showProject, showGlobal, setShowProject, setShowGlobal }
}

export function filterSkillsByScope(
  skills: SkillCatalogItem[],
  visibility: Pick<SkillScopeVisibility, "showProject" | "showGlobal">,
): SkillCatalogItem[] {
  return skills.filter(
    (skill) =>
      (skill.scope === "project" && visibility.showProject) ||
      (skill.scope === "global" && visibility.showGlobal),
  )
}

export function useVisibleSkills(
  skills: SkillCatalogItem[],
  visibility: Pick<SkillScopeVisibility, "showProject" | "showGlobal">,
): SkillCatalogItem[] {
  return filterSkillsByScope(skills, visibility)
}

/** Shared independent scope controls used by the Skills workspace and sidebar. */
export function SkillScopeControls({
  visibility,
  testIdPrefix,
}: {
  visibility: SkillScopeVisibility
  testIdPrefix: string
}) {
  const t = useTranslate()
  return (
    <div
      data-testid={`${testIdPrefix}-scope-controls`}
      className="flex items-center gap-1 rounded-md border border-border bg-background p-0.5"
    >
      <ScopeButton
        testId={`${testIdPrefix}-show-project`}
        label={t("Project-local")}
        description={t("Show or hide project-local skills in every Skills view")}
        checked={visibility.showProject}
        onChange={visibility.setShowProject}
      />
      <ScopeButton
        testId={`${testIdPrefix}-show-global`}
        label={t("Global")}
        description={t("Show or hide global skills in every Skills view")}
        checked={visibility.showGlobal}
        onChange={visibility.setShowGlobal}
      />
    </div>
  )
}

function ScopeButton({
  testId,
  label,
  description,
  checked,
  onChange,
}: {
  testId: string
  label: string
  description: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-testid={testId}
      data-feature-label={label}
      data-feature-help={description}
      onClick={() => onChange(!checked)}
      className={cn(
        "rounded px-2 py-1 text-[11px] transition-colors",
        checked
          ? "bg-accent text-foreground"
          : "text-muted-foreground/60 hover:text-muted-foreground",
      )}
    >
      {label}
    </button>
  )
}

export function skillKey(skill: SkillCatalogItem): string {
  return skill.path
}

/** Shared Cluster-style skill card with explicit scope and source labels. */
export function SkillCard({ skill, selected }: { skill: SkillCatalogItem; selected: boolean }) {
  const t = useTranslate()
  return (
    <div
      data-testid="skill-card"
      data-skill={skill.slug}
      data-scope={skill.scope}
      data-harness={skill.harness}
      data-selected={selected}
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-card/40 p-4",
        selected ? "border-ring ring-1 ring-ring" : "border-border",
      )}
    >
      <div className="flex items-center gap-2">
        <FlaskConical className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span data-testid="skill-name" className="min-w-0 flex-1 truncate font-medium text-sm">
          {skill.name}
        </span>
        <Badge data-testid="skill-scope" variant="outline">
          {t(skill.scope === "project" ? "Project-local" : "Global")}
        </Badge>
      </div>
      {skill.description ? (
        <p className="text-muted-foreground text-xs leading-relaxed">{skill.description}</p>
      ) : null}
      <div className="flex items-center gap-2">
        <Badge data-testid="skill-harness" variant="muted">
          {skill.harness}
        </Badge>
        <span
          data-testid="skill-source"
          className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/70"
        >
          {skill.source}
        </span>
      </div>
    </div>
  )
}

/** A non-fatal warning when one root could only be partially indexed. */
export function SkillRootWarnings({
  roots,
  testIdPrefix,
}: {
  roots: SkillCatalogRoot[]
  testIdPrefix: string
}) {
  const t = useTranslate()
  const warnings = roots.filter((root) => root.status === "unreadable" || root.status === "partial")
  if (warnings.length === 0) return null
  return (
    <div
      data-testid={`${testIdPrefix}-warnings`}
      className="cursor-text select-text rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-xs"
    >
      {warnings.map((root) => (
        <p key={`${root.scope}:${root.source}`}>
          {root.detail ?? `${t("Could not completely read")} ${root.source}.`}
        </p>
      ))}
    </div>
  )
}

export function SkillsMessage({
  testId,
  title,
  detail,
  destructive,
}: {
  testId: string
  title: string
  detail: string
  destructive: boolean
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center",
        destructive ? "border-destructive/40 text-destructive" : "border-border",
      )}
    >
      <FlaskConical
        className={cn("size-7", destructive ? "text-destructive" : "text-muted-foreground")}
        aria-hidden
      />
      <p className="font-medium text-sm">{title}</p>
      <p
        className={cn(
          "max-w-sm cursor-text select-text text-xs leading-relaxed",
          destructive ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {detail}
      </p>
    </div>
  )
}
