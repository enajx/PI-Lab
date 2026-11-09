import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { Button, Input } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslate } from "../../../../i18n/language"
import { useTRPC } from "../../../../trpc/react"
import { ToggleField } from "./SettingsControls"

/**
 * Overleaf rows of the LaTeX settings: the one Overleaf Git token used for every
 * project (save, replace, remove; the token is never shown), or a note that the
 * user's own Git credentials already hold one (a token can still be saved, and
 * a saved token is used first), and whether Sync asks before committing edits
 * not yet sent.
 */
export function OverleafSettings() {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [token, setToken] = useState("")
  const status = useQuery(trpc.paper.token.status.queryOptions())
  const settings = useQuery(trpc.settings.get.queryOptions())
  const editor = settings.data?.editor ?? DEFAULT_EDITOR_SETTINGS
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: trpc.paper.token.status.queryKey() })
  }
  const save = useMutation(
    trpc.paper.token.set.mutationOptions({
      onSuccess: () => {
        setToken("")
        refresh()
      },
    }),
  )
  const clear = useMutation(trpc.paper.token.clear.mutationOptions({ onSuccess: refresh }))
  const update = useMutation(
    trpc.settings.updateEditor.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
      },
    }),
  )
  const source = status.data?.source ?? null
  const configured = source === "saved"
  const error = status.error ?? save.error ?? clear.error ?? update.error

  return (
    <>
      <div className="flex flex-col gap-2 px-4 py-3 text-sm">
        <div className="flex items-center justify-between gap-4">
          <span>{t("Overleaf Git token")}</span>
          <span
            data-testid="settings-overleaf-token-state"
            className="text-muted-foreground text-xs"
          >
            {status.isPending
              ? t("Checking…")
              : source === "saved"
                ? t("Saved")
                : source === "git"
                  ? t("Overleaf Git detected")
                  : t("Not saved")}
          </span>
        </div>
        <p className="text-muted-foreground text-xs">
          {t(
            "Used by the LaTeX Editor to clone and sync Overleaf projects. Saved encrypted with the macOS keychain.",
          )}
        </p>
        <div className="flex items-center gap-2">
          <Input
            data-testid="settings-overleaf-token"
            type="password"
            aria-label={t("Overleaf Git token")}
            placeholder={configured ? t("New token") : t("Token")}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <Button
            data-testid="settings-overleaf-token-save"
            variant="outline"
            size="sm"
            disabled={token.trim() === "" || save.isPending}
            onClick={() => save.mutate({ token: token.trim() })}
          >
            {configured ? t("Replace") : t("Save")}
          </Button>
          {configured ? (
            <Button
              data-testid="settings-overleaf-token-remove"
              variant="outline"
              size="sm"
              disabled={clear.isPending}
              onClick={() => clear.mutate()}
            >
              {t("Remove")}
            </Button>
          ) : null}
        </div>
      </div>
      <ToggleField
        testId="settings-overleaf-confirm-commit"
        label="Ask before committing on Sync"
        description="Ask before Overleaf Sync commits edits not yet sent."
        checked={editor.confirmOverleafCommit}
        onChange={(value) => update.mutate({ confirmOverleafCommit: value })}
      />
      {error ? (
        <p role="alert" className="px-4 py-3 text-destructive text-sm">
          {error.message}
        </p>
      ) : null}
    </>
  )
}
