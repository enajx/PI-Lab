import type { ProjectType } from "@pi-lab/local-db"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { translateKnownError } from "../../../../../i18n/errors"
import { useInterfaceLanguage, useTranslate } from "../../../../../i18n/language"
import { useTRPC } from "../../../../../trpc/react"

/** Edit guidance used for project instructions and RESEARCH.md drafts. */
export function ProjectTypesEditor() {
  const t = useTranslate()
  const [language] = useInterfaceLanguage()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const settings = useQuery(trpc.settings.get.queryOptions())
  const types = settings.data?.projectTemplate.projectTypes ?? []
  const save = useMutation(
    trpc.settings.updateProjectTypeGuidance.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() }),
    }),
  )

  return (
    <div className="rounded-lg border border-border p-3" data-testid="project-types-editor">
      <h3 className="font-medium text-sm">{t("Project types")}</h3>
      <p className="mt-1 text-muted-foreground text-xs">
        {t("Guidance is added to project agent instructions and used when drafting RESEARCH.md.")}
      </p>
      <div className="mt-3 flex flex-col gap-3">
        {types.map((type) => (
          <ProjectTypeRow
            key={type.id}
            type={type}
            busy={save.isPending}
            onSave={(guidance) =>
              save.mutate({ id: type.id as "research" | "software" | "manuscript", guidance })
            }
          />
        ))}
      </div>
      {(save.error ?? settings.error) ? (
        <p role="alert" className="mt-2 text-destructive text-xs">
          {translateKnownError(language, (save.error ?? settings.error)?.message ?? "")}
        </p>
      ) : null}
    </div>
  )
}

/** Editable guidance for one built-in type. */
function ProjectTypeRow({
  type,
  busy,
  onSave,
}: {
  type: ProjectType
  busy: boolean
  onSave: (guidance: string) => void
}) {
  const t = useTranslate()
  const displayName =
    type.id === "research"
      ? t("Research project")
      : type.id === "software"
        ? t("Software project")
        : type.id === "manuscript"
          ? t("Manuscript")
          : type.name
  const [guidance, setGuidance] = useState(type.guidance)
  useEffect(() => setGuidance(type.guidance), [type.guidance])
  return (
    <div className="rounded border border-border p-2" data-testid={`project-type-${type.id}`}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-sm">{displayName}</span>
        <button
          type="button"
          disabled={guidance === type.guidance || busy}
          onClick={() => onSave(guidance)}
          className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
        >
          {t("Save")}
        </button>
      </div>
      <textarea
        aria-label={`${displayName}${t(" guidance")}`}
        value={guidance}
        onChange={(event) => setGuidance(event.target.value)}
        className="mt-2 min-h-20 w-full rounded border border-border bg-background px-2 py-1 text-sm"
      />
    </div>
  )
}
