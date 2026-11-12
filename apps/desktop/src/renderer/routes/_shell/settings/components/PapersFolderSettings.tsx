import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { Button, Input } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslate } from "../../../../i18n/language"
import { useDisplayPath } from "../../../../trpc/displayPath"
import { useTRPC, useTRPCClient } from "../../../../trpc/react"
import { ToggleField } from "./SettingsControls"

/**
 * LaTeX settings rows for papers added with no project: the folder they go in
 * (one folder per paper; typed, with `~` for the home folder, or chosen with
 * Choose…), and whether the LaTeX Editor asks where to put each new paper.
 */
export function PapersFolderSettings() {
  const t = useTranslate()
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const display = useDisplayPath()
  const settings = useQuery(trpc.settings.get.queryOptions())
  const editor = settings.data?.editor ?? DEFAULT_EDITOR_SETTINGS
  // The typed folder, or null while it shows the saved one.
  const [draft, setDraft] = useState<string | null>(null)
  const update = useMutation(
    trpc.settings.updateEditor.mutationOptions({
      onSuccess: () => {
        setDraft(null)
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
      },
    }),
  )
  const choose = useMutation({
    mutationFn: () => client.system.pickDirectory.mutate(),
    onSuccess: (dir) => {
      if (dir) update.mutate({ papersFolder: display(dir) })
    },
  })
  const error = update.error ?? choose.error

  return (
    <>
      <div className="flex flex-col gap-2 px-4 py-3 text-sm">
        <span>{t("Papers folder")}</span>
        <p className="text-muted-foreground text-xs">
          {t("Papers added in the LaTeX Editor with no project go here, one folder each.")}
        </p>
        <div className="flex items-center gap-2">
          <Input
            data-testid="settings-papers-folder"
            aria-label={t("Papers folder")}
            className="font-mono text-xs"
            value={draft ?? editor.papersFolder}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            data-testid="settings-papers-folder-save"
            variant="outline"
            size="sm"
            disabled={draft === null || draft.trim() === "" || update.isPending}
            onClick={() => {
              if (draft !== null) update.mutate({ papersFolder: draft.trim() })
            }}
          >
            {t("Save")}
          </Button>
          <Button
            data-testid="settings-papers-folder-choose"
            variant="outline"
            size="sm"
            disabled={choose.isPending || update.isPending}
            onClick={() => choose.mutate()}
          >
            {t("Choose…")}
          </Button>
        </div>
      </div>
      <ToggleField
        testId="settings-papers-folder-ask"
        label="Ask where to put new papers"
        description="Ask for the folder of each new paper, proposing one in the papers folder."
        checked={editor.askPapersFolder}
        onChange={(value) => update.mutate({ askPapersFolder: value })}
      />
      {error ? (
        <p role="alert" className="cursor-text select-text px-4 py-3 text-destructive text-sm">
          {error.message}
        </p>
      ) : null}
    </>
  )
}
