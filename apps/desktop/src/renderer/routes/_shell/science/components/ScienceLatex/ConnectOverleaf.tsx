import { Input } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslate } from "../../../../../i18n/language"
import { useTRPC } from "../../../../../trpc/react"
import { DialogError, PaperDialog } from "./PaperSyncBar"

/** Overleaf's project list, where a Blank project is created. */
const OVERLEAF_PROJECTS_URL = "https://www.overleaf.com/project"
/** Overleaf's account settings, where a Git token is created. */
const TOKEN_URL = "https://www.overleaf.com/user/settings"
const linkClass = "text-muted-foreground underline underline-offset-2 hover:text-foreground"

/**
 * The "Connect to Overleaf" dialog for a paper folder with no Git remote (for
 * example one made with Create paper). Overleaf has no API to create projects,
 * so it tells the user to create a Blank project on Overleaf and paste its Git
 * URL. PI Lab then merges that project in, keeps the local files over
 * Overleaf's default ones, and pushes (`paper.connectOverleaf`). The Overleaf
 * token is asked for only when none is available.
 */
export function ConnectOverleafDialog({
  projectId,
  onClose,
}: {
  projectId: string
  onClose: () => void
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [error, setError] = useState<string | null>(null)
  const tokenStatus = useQuery(trpc.paper.token.status.queryOptions())
  const needsToken = tokenStatus.data?.configured === false
  const setTokenMutation = useMutation(trpc.paper.token.set.mutationOptions())
  const connect = useMutation(
    trpc.paper.connectOverleaf.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.paper.get.queryKey({ projectId }) })
        void queryClient.invalidateQueries({ queryKey: trpc.paper.token.status.queryKey() })
        onClose()
      },
      onError: (cause) => setError(cause.message),
    }),
  )
  const busy = connect.isPending || setTokenMutation.isPending

  const submit = async (): Promise<void> => {
    setError(null)
    if (needsToken) {
      const saved = await setTokenMutation.mutateAsync({ token: token.trim() }).then(
        () => true,
        (cause: { message: string }) => {
          setError(cause.message)
          return false
        },
      )
      if (!saved) return
    }
    connect.mutate({ projectId, url: url.trim() })
  }
  const canSubmit =
    !busy && tokenStatus.isSuccess && url.trim() !== "" && (!needsToken || token.trim() !== "")

  return (
    <PaperDialog
      testId="paper-connect-dialog"
      title={t("Connect to Overleaf")}
      onClose={busy ? () => undefined : onClose}
    >
      <ol className="mt-2 list-decimal space-y-1 ps-5 text-muted-foreground text-xs">
        <li>
          {t("On Overleaf, create a Blank project.")}{" "}
          {/* A new-window link is handed to the user's browser by the main process. */}
          <a href={OVERLEAF_PROJECTS_URL} target="_blank" rel="noreferrer" className={linkClass}>
            {t("Open Overleaf")}
          </a>
        </li>
        <li>{t("In that project, open Integrations > Git and copy the Git URL.")}</li>
        <li>{t("Paste it here. Your files replace Overleaf's default ones.")}</li>
      </ol>
      <div className="mt-3 flex flex-col gap-2">
        <Input
          data-testid="paper-connect-url"
          aria-label={t("Overleaf Git URL")}
          placeholder="https://git@git.overleaf.com/…"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        {needsToken ? (
          <>
            <Input
              data-testid="paper-connect-token"
              type="password"
              aria-label={t("Overleaf Git token")}
              placeholder={t("Overleaf Git token")}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            <a href={TOKEN_URL} target="_blank" rel="noreferrer" className={`${linkClass} text-xs`}>
              {t("Get a Git token")}
            </a>
          </>
        ) : null}
      </div>
      <DialogError error={error ?? tokenStatus.error?.message ?? null} />
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          data-testid="paper-connect-cancel"
          disabled={busy}
          onClick={onClose}
          className="rounded border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
        >
          {t("Cancel")}
        </button>
        <button
          type="button"
          data-testid="paper-connect-submit"
          disabled={!canSubmit}
          onClick={() => void submit()}
          className="rounded bg-primary px-3 py-1.5 text-primary-foreground text-xs hover:bg-primary/90 disabled:opacity-50"
        >
          {connect.isPending ? t("Connecting…") : t("Connect")}
        </button>
      </div>
    </PaperDialog>
  )
}
