import { Input } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FolderOpen, GitBranch } from "lucide-react"
import { useState } from "react"
import { useTranslate } from "../../../../../i18n/language"
import { useTRPC } from "../../../../../trpc/react"

/**
 * Shown when the chosen project has no paper linked yet. Offers the two agreed
 * ways to link one, side by side as two equal cards (stacked when the page is
 * too narrow): clone an Overleaf project into `<project>/paper/` from its Git
 * URL, or link a folder the user already cloned (inside or outside the
 * project). The one Overleaf token is asked for here only when none is saved.
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
        <section
          data-testid="paper-setup-overleaf"
          className="flex flex-col gap-2 rounded-lg border border-border p-4"
        >
          <h2 className="flex items-center gap-2 font-medium text-sm">
            <GitBranch className="size-4" aria-hidden />
            {t("Add Overleaf project")}
          </h2>
          <p className="text-muted-foreground text-xs">
            {t(
              "In Overleaf, open Integrations > Git and copy the Git URL. PI Lab clones it into the paper/ folder of this project. The project's own repository is not changed.",
            )}
          </p>
          <Input
            data-testid="paper-overleaf-url"
            aria-label={t("Overleaf Git URL")}
            placeholder="https://git@git.overleaf.com/…"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          {needsToken ? (
            <>
              <Input
                data-testid="paper-overleaf-token"
                type="password"
                aria-label={t("Overleaf Git token")}
                placeholder={t("Overleaf Git token")}
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                {t(
                  "Create a token in Overleaf under Account Settings > Git integration. It is saved encrypted with the macOS keychain and used for every project.",
                )}
              </p>
            </>
          ) : null}
          <button
            type="button"
            data-testid="paper-overleaf-add"
            disabled={!canSubmit}
            onClick={() => void submit()}
            className="self-start rounded bg-primary px-3 py-1.5 text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50"
          >
            {addOverleaf.isPending ? t("Cloning…") : t("Add Overleaf project")}
          </button>
        </section>

        <section
          data-testid="paper-setup-folder"
          className="flex flex-col gap-2 rounded-lg border border-border p-4"
        >
          <h2 className="flex items-center gap-2 font-medium text-sm">
            <FolderOpen className="size-4" aria-hidden />
            {t("Use an existing folder")}
          </h2>
          <p className="text-muted-foreground text-xs">
            {t("Link a paper folder you already cloned, inside or outside this project.")}
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
            className="self-start rounded border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
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
