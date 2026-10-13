import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { translateKnownError } from "../i18n/errors"
import { useInterfaceLanguage, useTranslate } from "../i18n/language"
import { useTRPC } from "../trpc/react"

interface ProjectMarkdownChoiceProps {
  projectId: string
  kind: "tasks" | "main"
  currentPath: string | null
  onSaved?: () => void
}

/** Select an existing project Markdown file, or create the default task file. */
export function ProjectMarkdownChoice({
  projectId,
  kind,
  currentPath,
  onSaved,
}: ProjectMarkdownChoiceProps) {
  const t = useTranslate()
  const [language] = useInterfaceLanguage()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [path, setPath] = useState("")
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.projects.get.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.science.tasks.list.queryKey() }),
    ])
    onSaved?.()
  }
  const select = useMutation(trpc.projects.setDocumentPath.mutationOptions({ onSuccess: refresh }))
  const create = useMutation(trpc.projects.createTaskFile.mutationOptions({ onSuccess: refresh }))
  const pick = useMutation(trpc.system.pickFile.mutationOptions())
  const busy = select.isPending || create.isPending || pick.isPending
  const error = select.error ?? create.error ?? pick.error

  const browse = () => {
    pick.mutate(undefined, {
      onSuccess: (selected) => {
        if (selected !== null) select.mutate({ id: projectId, kind, relPath: selected })
      },
    })
  }

  return (
    <div data-testid={`project-markdown-choice-${kind}`} className="flex flex-col gap-2 text-xs">
      <p className="text-muted-foreground">
        {kind === "tasks" ? t("Task source") : t("Main readme")}:{" "}
        {currentPath ?? t("No file selected")}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          aria-label={kind === "tasks" ? t("Task Markdown path") : t("Main Markdown path")}
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder={t("Path in project, e.g. notes/Work.md")}
          className="min-w-40 flex-1 rounded border border-border bg-background px-2 py-1 text-foreground"
        />
        <button
          type="button"
          disabled={busy || path.trim().length === 0}
          onClick={() => select.mutate({ id: projectId, kind, relPath: path.trim() })}
          className="rounded border border-border px-2 py-1 hover:bg-accent disabled:opacity-50"
        >
          {t("Select")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={browse}
          className="rounded border border-border px-2 py-1 hover:bg-accent disabled:opacity-50"
        >
          {t("Browse…")}
        </button>
        {kind === "tasks" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => create.mutate({ id: projectId })}
            className="rounded border border-border px-2 py-1 hover:bg-accent disabled:opacity-50"
          >
            {t("Create TODO.md")}
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {translateKnownError(language, error.message)}
        </p>
      ) : null}
    </div>
  )
}
