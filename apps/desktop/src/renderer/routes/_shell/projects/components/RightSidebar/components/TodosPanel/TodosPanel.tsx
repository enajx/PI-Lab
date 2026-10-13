import { useQuery } from "@tanstack/react-query"
import { ProjectMarkdownChoice } from "../../../../../../../components/ProjectMarkdownChoice"
import { translateKnownError } from "../../../../../../../i18n/errors"
import { useInterfaceLanguage, useTranslate } from "../../../../../../../i18n/language"
import { useTRPC } from "../../../../../../../trpc/react"
import { DocPanel } from "../DocPanel"

/** Render the selected task Markdown file and offer a project file picker. */
export function TodosPanel({ projectId, workspaceId }: { projectId: string; workspaceId: string }) {
  const t = useTranslate()
  const [language] = useInterfaceLanguage()
  const trpc = useTRPC()
  const project = useQuery(trpc.projects.get.queryOptions({ id: projectId }))
  const listing = useQuery(trpc.science.tasks.list.queryOptions())
  if (project.isPending)
    return <p className="px-4 py-3 text-muted-foreground text-sm">{t("Loading task source…")}</p>
  if (project.isError)
    return (
      <p role="alert" className="px-4 py-3 text-destructive text-sm">
        {translateKnownError(language, project.error.message)}
      </p>
    )
  const source = listing.data?.sources.find((candidate) => candidate.projectId === projectId)
  const relPath = project.data.taskRelPath ?? (source?.state === "ready" ? source.relPath : null)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border border-b px-4 py-3">
        <ProjectMarkdownChoice projectId={projectId} kind="tasks" currentPath={relPath} />
      </div>
      {relPath ? (
        <DocPanel
          workspaceId={workspaceId}
          relPath={relPath}
          testId="panel-todos"
          emptyTitle={t("No {path} yet").replace("{path}", relPath)}
          emptyHint={t(
            "Create TODO.md from your template or select a project Markdown file above.",
          )}
        />
      ) : (
        <section data-testid="panel-todos" className="px-4 py-3 text-muted-foreground text-sm">
          {listing.isPending
            ? t("Finding the project's task Markdown file…")
            : listing.isError
              ? translateKnownError(language, listing.error.message)
              : source?.state === "ambiguous"
                ? t("Several TODO files found: {paths}. Select one above.").replace(
                    "{paths}",
                    source.candidates.join(", "),
                  )
                : source?.state === "error"
                  ? translateKnownError(language, source.error ?? "Could not read task source")
                  : t("Create TODO.md from your template or select a project Markdown file above.")}
        </section>
      )}
    </div>
  )
}
