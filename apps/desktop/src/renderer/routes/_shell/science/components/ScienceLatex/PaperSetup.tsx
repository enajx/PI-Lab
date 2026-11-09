import { Input } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FolderOpen, GitBranch } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTranslate } from "../../../../../i18n/language"
import { useTRPC } from "../../../../../trpc/react"
import { usePaperFolderPicker } from "./PaperFolder"

/** Overleaf's account settings, where a Git token is created. */
const TOKEN_URL = "https://www.overleaf.com/user/settings"
/** Overleaf's documentation of its Git integration. */
const DOCS_URL =
  "https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration"
const cardClass =
  "flex flex-col items-center justify-center gap-3 rounded-lg border border-border p-6 text-center"
const linkClass = "text-muted-foreground underline underline-offset-2 hover:text-foreground"

/**
 * Shown when the chosen project has no paper folder yet. With `autoDetect` on
 * it first looks for Overleaf clones in the project (`paper.detect`): exactly
 * one is used right away, and several are listed to pick one (with a note when
 * the search stopped early on a large project). With it off (the user cleared
 * the paper folder) it does not search. Then it offers the two
 * agreed ways to set a paper folder, side by side as two cards of the same height
 * (stacked when the page is too narrow), centred on the page, each with its
 * content centred: clone an Overleaf project into `<project>/paper/` from its
 * Git URL, or open a folder the user already cloned. The one Overleaf token is
 * asked for only when none is available; the token and docs links are shown
 * only then. Choosing the project folder when it is not an Overleaf clone asks
 * first whether Sync stays on (Sync would commit and push the whole project).
 */
export function PaperSetup({
  projectId,
  autoDetect,
}: {
  projectId: string
  /** False after the user cleared the paper folder: no search for Overleaf clones. */
  autoDetect: boolean
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [error, setError] = useState<string | null>(null)
  const tokenStatus = useQuery(trpc.paper.token.status.queryOptions())
  const needsToken = tokenStatus.data?.configured === false
  const tokenFromGit = tokenStatus.data?.source === "git"
  const detect = useQuery({
    ...trpc.paper.detect.queryOptions({ projectId }),
    enabled: autoDetect,
  })

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
  const picker = usePaperFolderPicker(
    projectId,
    (chosen) => link.mutate({ projectId, dir: chosen.dir, rootChoice: chosen.rootChoice }),
    onError,
  )
  const busy = addOverleaf.isPending || link.isPending || setTokenMutation.isPending || picker.busy

  // Exactly one Overleaf clone in the project: link it once, without asking.
  // A disabled query still returns cached data (from a visit before the folder
  // was cleared), so results are ignored while auto-detection is off.
  const search = autoDetect ? detect.data : undefined
  const clones = search?.clones ?? []
  const onlyClone = clones.length === 1 ? (clones[0] ?? null) : null
  const autoLinked = useRef(false)
  const { mutate: linkMutate } = link
  useEffect(() => {
    if (!onlyClone || autoLinked.current) return
    autoLinked.current = true
    linkMutate({ projectId, dir: onlyClone.dir, rootChoice: null })
  }, [onlyClone, linkMutate, projectId])
  const autoLinking = autoDetect && (detect.isPending || (onlyClone !== null && !link.isError))

  /** Ask for a folder, check it (see {@link usePaperFolderPicker}), then use it. */
  const chooseFolder = (): void => {
    setError(null)
    picker.choose()
  }

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
    <div data-testid="paper-setup" className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
      <div
        data-testid="paper-setup-content"
        className="m-auto flex w-full max-w-4xl flex-col gap-4"
      >
        {autoLinking ? (
          <p data-testid="paper-detecting" className="text-center text-muted-foreground text-sm">
            {link.isPending
              ? t("Opening the Overleaf folder…")
              : t("Looking for Overleaf folders…")}
          </p>
        ) : (
          <>
            {search?.stoppedEarly ? (
              <p
                data-testid="paper-detect-stopped"
                className="text-center text-muted-foreground text-xs"
              >
                {t(
                  "This project has many folders, so the search for Overleaf folders stopped early. Choose the folder below if it was not found.",
                )}
              </p>
            ) : null}
            {clones.length > 1 ? (
              <section data-testid="paper-detected" className={cardClass}>
                <h2 className="font-medium text-sm">
                  {t("Overleaf folders found in this project")}
                </h2>
                <p className="text-muted-foreground text-xs">{t("Choose the paper folder.")}</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {clones.map((clone) => (
                    <button
                      key={clone.dir}
                      type="button"
                      data-testid="paper-detected-option"
                      disabled={busy}
                      onClick={() => {
                        setError(null)
                        link.mutate({ projectId, dir: clone.dir, rootChoice: null })
                      }}
                      className="rounded border border-border px-3 py-1.5 font-mono text-xs hover:bg-accent disabled:opacity-50"
                    >
                      {clone.relPath === "." ? t("Project folder (.)") : clone.relPath}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
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
                  <p
                    data-testid="paper-overleaf-token-found"
                    className="text-muted-foreground text-xs"
                  >
                    {t("Overleaf Git detected")}
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
                {needsToken ? (
                  <div className="flex gap-3 text-xs">
                    {/* A new-window link is handed to the user's browser by the main process. */}
                    <a href={TOKEN_URL} target="_blank" rel="noreferrer" className={linkClass}>
                      {t("Get a Git token")}
                    </a>
                    <a href={DOCS_URL} target="_blank" rel="noreferrer" className={linkClass}>
                      {t("How Overleaf Git works")}
                    </a>
                  </div>
                ) : null}
              </section>

              <section data-testid="paper-setup-folder" className={cardClass}>
                <FolderOpen className="size-5 text-muted-foreground" aria-hidden />
                <h2 className="font-medium text-sm">{t("Use an existing folder")}</h2>
                <p className="text-muted-foreground text-xs">
                  {t("Open a paper folder you already cloned.")}
                </p>
                <button
                  type="button"
                  data-testid="paper-use-folder"
                  disabled={busy}
                  onClick={chooseFolder}
                  className="rounded border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
                >
                  {t("Choose folder…")}
                </button>
              </section>
            </div>
          </>
        )}

        {autoDetect && detect.isError ? (
          <p role="alert" className="cursor-text select-text text-destructive text-xs">
            {detect.error.message}
          </p>
        ) : null}
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
      {picker.dialog}
    </div>
  )
}
