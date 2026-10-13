import { useQuery } from "@tanstack/react-query"
import { translateKnownError } from "../../../../../../../i18n/errors"
import { useInterfaceLanguage, useTranslate } from "../../../../../../../i18n/language"
import { useTRPC } from "../../../../../../../trpc/react"
import { DocPanel } from "../DocPanel"

/** Render the project's selected main Markdown file in the research panel. */
export function ResearchPanel({
  projectId,
  workspaceId,
}: {
  projectId: string
  workspaceId: string
}) {
  const t = useTranslate()
  const [language] = useInterfaceLanguage()
  const trpc = useTRPC()
  const project = useQuery(trpc.projects.get.queryOptions({ id: projectId }))
  if (project.isPending)
    return <p className="px-4 py-3 text-muted-foreground text-sm">{t("Loading main readme…")}</p>
  if (project.isError)
    return (
      <p role="alert" className="px-4 py-3 text-destructive text-sm">
        {translateKnownError(language, project.error.message)}
      </p>
    )
  const relPath = project.data.mainRelPath ?? "RESEARCH.md"
  return (
    <DocPanel
      workspaceId={workspaceId}
      relPath={relPath}
      testId="panel-research"
      emptyTitle={t("No {path} yet").replace("{path}", relPath)}
      emptyHint={t("Add {path} to the project to see it here.").replace("{path}", relPath)}
    />
  )
}
