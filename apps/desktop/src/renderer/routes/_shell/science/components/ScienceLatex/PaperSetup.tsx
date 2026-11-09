import { Input } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FolderOpen, GitBranch } from "lucide-react"
import { useState } from "react"
import { useTranslate } from "../../../../../i18n/language"
import { useTRPC } from "../../../../../trpc/react"

/** Overleaf's account settings, where a Git token is created. */
const TOKEN_URL = "https://www.overleaf.com/user/settings"
/** Overleaf's documentation of its Git integration. */
const DOCS_URL =
  "https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration"
const cardClass = "flex flex-col items-center gap-3 rounded-lg border border-border p-6 text-center"
const linkClass = "text-muted-foreground underline underline-offset-2 hover:text-foreground"

/**
 * Shown when the chosen project has no paper linked yet. Offers the two agreed
 * ways to link one, side by side as two equal cards (stacked when the page is
 * too narrow): clone an Overleaf project into `<project>/paper/` from its Git
 * URL, or link a folder the user already cloned (inside or outside the
 * project). The one Overleaf token is asked for here only when none is saved
 * and none is found in the user's Git credentials. Each card centres its
 * content.
 */
export function PaperSetup({ projectId }: { projectId: string }) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [error, setError] = useState<string | null>(null)
  const tokenStatus = useQuery(trpc.paper.token.status.queryOptions())
  const needsToken = tokenStatus.data?.configured === false
  const tokenFromGit = tokenStatus.data?.source === "git"

  const linked = (): void => {
    void queryClient.invalidateQueries({ queryKey: trpc.paper.get.queryKey({ projectId }) })
    void queryClient.invalidateQueries({ queryKey: trpc.paper.token.status.queryKey() })
  }
  const onError = (cause: { message: string }): void => setError(cause.message)
  const setTokenMutation = useMutation(trpc.paper.token.set.mutationOptions())
  const addOverleaf = useMutation(
    trpc.paper.addOverleaf.mutationOptions({ onSuccess: linked, onError }),
  )
  const link = useMutation(trpc.paper.link.mutationOptions({ onSuccess: linked, onError }))
  const pickDirectory = useMutation(trpc.system.pickDirectory.mutationOptions({ onError }))
  const busy =
    addOverleaf.isPending || link.isPending || setTokenMutation.isPending || pickDirectory.isPending

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
    addOverleaf.mutate({ projectId, url: url.trim() })
  }
  const canSubmit =
    !busy && tokenStatus.isSuccess && url.trim() !== "" && (!needsToken || token.trim() !== "")

  return (
    <div data-testid="paper-setup" className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(18rem,1fr))] gap-4">
        <section data-testid="paper-setup-overleaf" className={cardClass}>
          <GitBranch className="size-5 text-muted-foreground" aria-hidden />
          <h2 className="font-medium text-sm">{t("Add Overleaf project")}</h2>
          <p className="text-muted-foreground text-xs">
            {t("Clone your Overleaf project into paper/.")}
          </p>
          <Input
            data-testid="paper-overleaf-url"
            className="max-w-80"
            aria-label={t("Overleaf Git URL")}
            placeholder="https://git@git.overleaf.com/…"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          {needsToken ? (
            <Input
              data-testid="paper-overleaf-token"
              className="max-w-80"
              type="password"
              aria-label={t("Overleaf Git token")}
              placeholder={t("Overleaf Git token")}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          ) : tokenFromGit ? (
            <p data-testid="paper-overleaf-token-found" className="text-muted-foreground text-xs">
              {t("Token found in your Git credentials")}
            </p>
          ) : null}
          <button
            type="button"
            data-testid="paper-overleaf-add"
            disabled={!canSubmit}
            onClick={() => void submit()}
            className="rounded bg-primary px-3 py-1.5 text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50"
          >
            {addOverleaf.isPending ? t("Cloning…") : t("Add Overleaf project")}
          </button>
          <div className="flex gap-3 text-xs">
            {/* A new-window link is handed to the user's browser by the main process. */}
            <a href={TOKEN_URL} target="_blank" rel="noreferrer" className={linkClass}>
              {t("Get a Git token")}
            </a>
            <a href={DOCS_URL} target="_blank" rel="noreferrer" className={linkClass}>
              {t("How Overleaf Git works")}
            </a>
          </div>
        </section>

        <section data-testid="paper-setup-folder" className={cardClass}>
          <FolderOpen className="size-5 text-muted-foreground" aria-hidden />
          <h2 className="font-medium text-sm">{t("Use an existing folder")}</h2>
          <p className="text-muted-foreground text-xs">
            {t("Link a paper folder you already cloned.")}
          </p>
          <button
            type="button"
            data-testid="paper-use-folder"
            disabled={busy}
            onClick={() => {
              setError(null)
              pickDirectory.mutate(undefined, {
                onSuccess: (dir) => {
                  if (dir) link.mutate({ projectId, dir })
                },
              })
            }}
            className="rounded border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            {t("Choose folder…")}
          </button>
        </section>
      </div>

      {tokenStatus.isError ? (
        <p role="alert" className="cursor-text select-text text-destructive text-xs">
          {tokenStatus.error.message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="cursor-text select-text text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  )
}
