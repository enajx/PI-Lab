import { Input } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FilePlus, FolderOpen, GitBranch } from "lucide-react"
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
  "flex flex-col items-center justify-center gap-2 rounded-lg border border-border p-4 text-center"
const linkClass = "text-muted-foreground underline underline-offset-2 hover:text-foreground"

/**
 * Shown when the chosen project has no paper folder yet. With `autoDetect` on
 * it first looks for Overleaf clones in the project (`paper.detect`): exactly
 * one is used right away, and several are listed to pick one (with a note when
 * the search stopped early on a large project). With it off (the user cleared
 * the paper folder) it does not search. Then it offers the three
 * agreed ways to set a paper folder, side by side as narrow cards of the same height
 * (stacked when the page is too narrow), at the top of the page and horizontally centred, each with its
 * content centred: clone an Overleaf project into `<project>/paper/` from its
 * Git URL, open a folder the user already cloned, or create a new paper from
 * the LaTeX template (in `<project>/paper/`, or a folder the user chooses;
 * see `paper.create`). The one Overleaf token is
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
  const createTarget = useQuery(trpc.paper.createTarget.queryOptions({ projectId }))
  // The folder the user chose for Create paper, or null for the default (<project>/paper).
  const [createDir, setCreateDir] = useState<string | null>(null)
  const pickCreateDir = useMutation(
    trpc.system.pickDirectory.mutationOptions({
      onSuccess: (dir) => {
        if (dir) setCreateDir(dir)
      },
      onError,
    }),
  )
  const create = useMutation(trpc.paper.create.mutationOptions({ onSuccess: linked, onError }))
  const createInto = createDir ?? (createTarget.data?.available ? createTarget.data.dir : null)
  const busy =
    addOverleaf.isPending ||
    link.isPending ||
    setTokenMutation.isPending ||
    picker.busy ||
    create.isPending ||
    pickCreateDir.isPending

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
    <div data-testid="paper-setup" className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      <div
        data-testid="paper-setup-content"
        className="mx-auto flex w-full max-w-5xl flex-col gap-3"
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
            <div className="grid grid-cols-[repeat(auto-fit,minmax(16rem,20rem))] justify-center gap-3">
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

              <section data-testid="paper-setup-create" className={cardClass}>
                <FilePlus className="size-5 text-muted-foreground" aria-hidden />
                <h2 className="font-medium text-sm">{t("Create paper")}</h2>
                <p className="text-muted-foreground text-xs">
                  {t("Start a new paper from your LaTeX template.")}
                </p>
                <div className="flex max-w-full items-center gap-2 text-xs">
                  <span
                    data-testid="paper-create-folder"
                    title={createDir ?? createTarget.data?.dir}
                    className="min-w-0 truncate font-mono [direction:rtl]"
                  >
                    <bdi>
                      {createDir ??
                        (createTarget.data
                          ? createTarget.data.available
                            ? `${createTarget.data.displayDir}/`
                            : t("paper/ has files in it, choose a folder")
                          : "")}
                    </bdi>
                  </span>
                  <button
                    type="button"
                    data-testid="paper-create-change"
                    disabled={busy}
                    onClick={() => {
                      setError(null)
                      pickCreateDir.mutate()
                    }}
                    className={`${linkClass} shrink-0 disabled:opacity-50`}
                  >
                    {t("Change…")}
                  </button>
                </div>
                <button
                  type="button"
                  data-testid="paper-create"
                  disabled={busy || createInto === null}
                  onClick={() => {
                    if (createInto === null) return
                    setError(null)
                    create.mutate({ projectId, dir: createInto })
                  }}
                  className="rounded bg-primary px-3 py-1.5 text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50"
                >
                  {create.isPending ? t("Creating…") : t("Create paper")}
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
