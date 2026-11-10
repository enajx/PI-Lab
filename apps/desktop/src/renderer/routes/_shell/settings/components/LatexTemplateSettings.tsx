import { Button } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useTranslate } from "../../../../i18n/language"
import { useTRPC } from "../../../../trpc/react"

/**
 * The "LaTeX template" row of the LaTeX settings: which template the LaTeX
 * Editor's Start draft uses. "Set new LaTeX template…" picks a folder whose
 * files are copied into PI Lab (so later changes to that folder do not change
 * the template); "Use built-in template" goes back to the one PI Lab ships.
 */
export function LatexTemplateSettings() {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const status = useQuery(trpc.paper.template.status.queryOptions())
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: trpc.paper.template.status.queryKey() })
  }
  const set = useMutation(trpc.paper.template.set.mutationOptions({ onSuccess: refresh }))
  const clear = useMutation(trpc.paper.template.clear.mutationOptions({ onSuccess: refresh }))
  const pick = useMutation(
    trpc.system.pickDirectory.mutationOptions({
      onSuccess: (dir) => {
        if (dir) set.mutate({ dir })
      },
    }),
  )
  const custom = status.data?.custom ?? null
  const busy = set.isPending || clear.isPending || pick.isPending
  const error = status.error ?? set.error ?? clear.error ?? pick.error

  return (
    <div className="flex flex-col gap-2 px-4 py-3 text-sm">
      <div className="flex items-center justify-between gap-4">
        <span>{t("LaTeX template")}</span>
        <span
          data-testid="settings-latex-template-state"
          title={custom ? `${custom.files.join("\n")}` : undefined}
          className="min-w-0 truncate text-muted-foreground text-xs"
        >
          {status.isPending
            ? t("Checking…")
            : custom
              ? `${t("Copied from")} ${custom.source}`
              : t("Built-in template")}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">
        {t(
          "Used by Start draft in the LaTeX Editor. A new template's files are copied into PI Lab.",
        )}
      </p>
      <div className="flex items-center gap-2">
        <Button
          data-testid="settings-latex-template-set"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => pick.mutate()}
        >
          {set.isPending ? t("Copying…") : t("Set new LaTeX template…")}
        </Button>
        {custom ? (
          <Button
            data-testid="settings-latex-template-clear"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => clear.mutate()}
          >
            {t("Use built-in template")}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="cursor-text select-text text-destructive text-xs">
          {error.message}
        </p>
      ) : null}
    </div>
  )
}
