import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { Button } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useTranslate } from "../../../../i18n/language"
import { useDisplayPath } from "../../../../trpc/displayPath"
import { useTRPC, useTRPCClient } from "../../../../trpc/react"

/**
 * LaTeX settings row for the remembered answer to "where should the Overleaf
 * project be cloned?" (Add Overleaf project in an existing project): shows it,
 * changes it to inside the project or a chosen folder (clones then go in
 * `<folder>/<Overleaf project id>`), or resets it so PI Lab asks again.
 */
export function OverleafCloneSettings() {
  const t = useTranslate()
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const display = useDisplayPath()
  const settings = useQuery(trpc.settings.get.queryOptions())
  const editor = settings.data?.editor ?? DEFAULT_EDITOR_SETTINGS
  const update = useMutation(
    trpc.settings.updateEditor.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() }),
    }),
  )
  const choose = useMutation({
    mutationFn: () => client.system.pickDirectory.mutate(),
    onSuccess: (dir) => {
      if (dir) update.mutate({ overleafCloneLocation: "folder", overleafCloneFolder: display(dir) })
    },
  })
  const error = update.error ?? choose.error
  const current =
    editor.overleafCloneLocation === "project"
      ? t("Inside the project (<project>/paper)")
      : editor.overleafCloneLocation === "folder"
        ? `${editor.overleafCloneFolder}/<${t("Overleaf project id")}>`
        : t("Ask each time")

  return (
    <div className="flex flex-col gap-2 px-4 py-3 text-sm">
      <span>{t("Overleaf clone location")}</span>
      <p className="text-muted-foreground text-xs">
        {t("Where Add Overleaf project clones the paper of an existing project.")}
      </p>
      <p data-testid="settings-overleaf-clone-location" className="font-mono text-xs">
        {current}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="settings-overleaf-clone-project"
          variant="outline"
          size="sm"
          disabled={update.isPending || editor.overleafCloneLocation === "project"}
          onClick={() => update.mutate({ overleafCloneLocation: "project" })}
        >
          {t("Inside the project")}
        </Button>
        <Button
          data-testid="settings-overleaf-clone-choose"
          variant="outline"
          size="sm"
          disabled={choose.isPending || update.isPending}
          onClick={() => choose.mutate()}
        >
          {t("Choose folder…")}
        </Button>
        <Button
          data-testid="settings-overleaf-clone-reset"
          variant="outline"
          size="sm"
          disabled={update.isPending || editor.overleafCloneLocation === "ask"}
          onClick={() => update.mutate({ overleafCloneLocation: "ask" })}
        >
          {t("Reset")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="cursor-text select-text text-destructive text-sm">
          {error.message}
        </p>
      ) : null}
    </div>
  )
}
