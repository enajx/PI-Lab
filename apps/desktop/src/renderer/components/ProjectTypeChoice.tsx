import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { translateKnownError } from "../i18n/errors"
import { useInterfaceLanguage, useTranslate } from "../i18n/language"
import { useTRPC } from "../trpc/react"

/** Compact selector for a project's saved type, including the untyped state. */
export function ProjectTypeChoice({
  projectId,
  typeId,
  testId,
}: {
  projectId: string
  typeId: string | null
  testId: string
}) {
  const t = useTranslate()
  const [language] = useInterfaceLanguage()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const settings = useQuery(trpc.settings.get.queryOptions())
  const types = settings.data?.projectTemplate?.projectTypes ?? []
  const selected = types.some((type) => type.id === typeId) ? (typeId ?? "") : ""
  const setType = useMutation(
    trpc.projects.setType.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.projects.get.queryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() }),
        ]),
    }),
  )

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <select
        aria-label={t("Project type")}
        data-testid={testId}
        title={t("Project type")}
        value={selected}
        disabled={setType.isPending}
        onChange={(event) => {
          if (event.target.value) setType.mutate({ id: projectId, typeId: event.target.value })
        }}
        className="max-w-40 rounded border border-border bg-background px-1.5 py-1 text-xs"
      >
        <option value="" disabled={Boolean(selected)}>
          {t("Choose type")}
        </option>
        {types.map((type) => (
          <option key={type.id} value={type.id}>
            {type.id === "research"
              ? t("Research project")
              : type.id === "software"
                ? t("Software project")
                : type.id === "manuscript"
                  ? t("Manuscript")
                  : type.name}
          </option>
        ))}
      </select>
      {(setType.error ?? settings.error) ? (
        <span role="alert" className="text-destructive text-xs">
          {translateKnownError(language, (setType.error ?? settings.error)?.message ?? "")}
        </span>
      ) : null}
    </div>
  )
}
