import { Button, Input } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FilePlus, FolderOpen, GitBranch } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { BuildResult } from "../../../../../../main/trpc/pdf/pdf"
import { useTranslate } from "../../../../../i18n/language"
import { useDisplayPath } from "../../../../../trpc/displayPath"
import { useTRPC, useTRPCClient } from "../../../../../trpc/react"
import { usePaperDestination } from "./PaperDestination"
import { usePaperFolderPicker } from "./PaperFolder"

/** Overleaf's account settings, where a Git token is created. */
const TOKEN_URL = "https://www.overleaf.com/user/settings"
/** Overleaf's documentation of its Git integration. */
const DOCS_URL =
  "https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration"
/** The card of the Library's source chooser (LibrarySourceChooser), so both setup pages look the same. */
const cardClass = "flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card/40 p-4"
const cardTitleClass = "font-medium text-foreground text-sm"
const cardTextClass = "text-muted-foreground text-xs leading-relaxed"
const linkClass = "text-muted-foreground underline underline-offset-2 hover:text-foreground"

/** A paper Start draft just made: its workspace and the build of its main .tex (null when none ran). */
export interface CreatedPaper {
  workspaceId: string | null
  /** Settled before the page is told; it rejects when the build could not run. */
  build: Promise<BuildResult> | null
}

/**
 * Shown when the chosen project has no paper folder yet. With `autoDetect` on
 * it first looks for Overleaf clones in the project (`paper.detect`): exactly
 * one is used right away, and several are listed to pick one (with a note when
 * the search stopped early on a large project). With it off (the user cleared
 * the paper folder) it does not search. Then it offers the three
 * agreed ways to set a paper folder as three cards of the same height, laid out like the
 * Library's source chooser (same width, padding, card style, text sizes and buttons): clone an Overleaf project into `<project>/paper/` from its
 * Git URL, open a folder the user already cloned, or start a draft: a new
 * paper from the LaTeX template (in `<project>/paper/`, or the next free
 * `paper-2/`, `paper-3/`, … when it has files, or an empty folder the user
 * chooses; see `paper.createTarget` and `paper.create`). The one Overleaf token is
 * asked for only when none is available (it is sent with the clone and saved
 * only when the clone works); the token and docs links are shown only then. Choosing the project folder when it is not an Overleaf clone asks
 * first whether Sync stays on (Sync would commit and push the whole project).
 *
 * With `projectId` null (the LaTeX Editor with no project, or New paper… in
 * its picker) the same cards add a paper with no project: a paper-only project
 * (`paper.addStandalone`). A clone or draft goes into a new folder asked for by
 * {@link usePaperDestination}; `onAdded` gets the new project.
 */
export function PaperSetup({
  projectId,
  autoDetect,
  onCreateStart,
  onCreated,
  onAdded,
}: {
  /** The project to set the paper folder of, or null to add a paper with no project. */
  projectId: string | null
  /** False after the user cleared the paper folder: no search for Overleaf clones. */
  autoDetect: boolean
  /** Start draft started; the page keeps the setup shown until `onCreated`. */
  onCreateStart: () => void
  /** Start draft finished: the new paper with its PDF build, or null when creating it failed. */
  onCreated: (paper: CreatedPaper | null) => void
  /** A paper with no project was added as the paper-only project with this id. */
  onAdded: (projectId: string) => void
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [error, setError] = useState<string | null>(null)
  const tokenStatus = useQuery(trpc.paper.token.status.queryOptions())
  const needsToken = tokenStatus.data?.configured === false
  const tokenFromGit = tokenStatus.data?.source === "git"
  const standalone = projectId === null
  const display = useDisplayPath()
  const destination = usePaperDestination()
  const detect = useQuery({
    ...trpc.paper.detect.queryOptions({ projectId: projectId ?? "" }),
    enabled: autoDetect && !standalone,
  })

  const linked = (): void => {
    if (standalone) void queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() })
    void queryClient.invalidateQueries({
      queryKey: trpc.paper.get.queryKey(projectId === null ? undefined : { projectId }),
    })
    void queryClient.invalidateQueries({ queryKey: trpc.paper.token.status.queryKey() })
  }
  const onError = (cause: { message: string }): void => setError(cause.message)
  const addOverleaf = useMutation(
    trpc.paper.addOverleaf.mutationOptions({ onSuccess: linked, onError }),
  )
  const link = useMutation(trpc.paper.link.mutationOptions({ onSuccess: linked, onError }))
  const picker = usePaperFolderPicker(
    projectId ?? "",
    (chosen) => {
      if (projectId !== null) {
        link.mutate({ projectId, dir: chosen.dir, rootChoice: chosen.rootChoice })
      }
    },
    onError,
  )
  // With no project: add the paper (clone, folder, or nothing when the folder question is cancelled).
  const addStandalone = useMutation({
    mutationFn: async (
      input: { source: "folder" } | { source: "overleaf"; url: string; token: string | null },
    ): Promise<string | null> => {
      if (input.source === "folder") {
        const dir = await client.system.pickDirectory.mutate()
        if (!dir) return null
        return (await client.paper.addStandalone.mutate({ source: "folder", dir })).projectId
      }
      const dir = await destination.ask(input.url)
      if (dir === null) return null
      return (
        await client.paper.addStandalone.mutate({
          source: "overleaf",
          url: input.url,
          dir,
          ...(input.token === null ? {} : { token: input.token }),
        })
      ).projectId
    },
    onSuccess: (added) => {
      if (added === null) return
      linked()
      onAdded(added)
    },
    onError,
  })
  const createTarget = useQuery({
    ...trpc.paper.createTarget.queryOptions({ projectId: projectId ?? "" }),
    enabled: !standalone,
  })
  const standaloneTarget = useQuery({
    ...trpc.paper.standaloneTarget.queryOptions({ url: null }),
    enabled: standalone,
  })
  // The folder the user chose for Start draft, or null for the default from `paper.createTarget`.
  const [createDir, setCreateDir] = useState<string | null>(null)
  // A chosen folder with files in it is not used: the previous choice stays and the user is told why.
  const pickCreateDir = useMutation({
    mutationFn: async (): Promise<void> => {
      const dir = await client.system.pickDirectory.mutate()
      if (!dir) return
      if (await client.paper.canCreateIn.query({ dir })) {
        setCreateDir(dir)
        return
      }
      setError(
        t(
          "That folder already has files. Choose an empty folder, or use 'Use an existing folder' to open it as a paper.",
        ),
      )
    },
    onError,
  })
  // Start draft also builds the main .tex, so the editor opens with its PDF beside it.
  const [createStep, setCreateStep] = useState<"creating" | "building">("creating")
  const create = useMutation({
    mutationFn: async (input: { projectId: string; dir: string }): Promise<CreatedPaper> => {
      setCreateStep("creating")
      const state = await client.paper.create.mutate(input)
      return buildCreated(state)
    },
    onMutate: onCreateStart,
    onSuccess: (paper) => {
      onCreated(paper)
      linked()
    },
    onError: (cause: { message: string }) => {
      onCreated(null)
      onError(cause)
    },
  })
  // Start draft with no project: ask for the folder (unless one was chosen with Change…), add, then build.
  const createStandalone = useMutation({
    mutationFn: async (): Promise<{ projectId: string; paper: CreatedPaper } | null> => {
      const dir = createDir ?? (await destination.ask(null))
      if (dir === null) return null
      setCreateStep("creating")
      const { projectId: added } = await client.paper.addStandalone.mutate({ source: "draft", dir })
      const paper = await buildCreated(await client.paper.get.query({ projectId: added }))
      return { projectId: added, paper }
    },
    onSuccess: (result) => {
      if (result === null) return
      onCreated(result.paper)
      linked()
      onAdded(result.projectId)
    },
    onError,
  })
  /** Build the new paper's main .tex, so the editor opens with its PDF beside it. */
  const buildCreated = async (state: {
    workspaceId: string | null
    rootRelPath: string | null
  }): Promise<CreatedPaper> => {
    if (!state.workspaceId || !state.rootRelPath) {
      return { workspaceId: state.workspaceId, build: null }
    }
    setCreateStep("building")
    const build = client.pdf.build.mutate({
      workspaceId: state.workspaceId,
      relPath: state.rootRelPath,
    })
    // A failed build still opens the paper; the editor shows the failure and its log.
    await build.then(
      () => undefined,
      () => undefined,
    )
    return { workspaceId: state.workspaceId, build }
  }
  const createInto = createDir ?? createTarget.data?.dir ?? null
  const creating = create.isPending || createStandalone.isPending
  const busy =
    addOverleaf.isPending ||
    addStandalone.isPending ||
    link.isPending ||
    picker.busy ||
    creating ||
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
    if (!onlyClone || autoLinked.current || projectId === null) return
    autoLinked.current = true
    linkMutate({ projectId, dir: onlyClone.dir, rootChoice: null })
  }, [onlyClone, linkMutate, projectId])
  const autoLinking = autoDetect && (detect.isPending || (onlyClone !== null && !link.isError))

  /** Ask for a folder, check it (see {@link usePaperFolderPicker}), then use it. */
  const chooseFolder = (): void => {
    setError(null)
    if (standalone) addStandalone.mutate({ source: "folder" })
    else picker.choose()
  }

  // A typed token is used for this clone and saved by the server only when it works.
  const submit = (): void => {
    setError(null)
    if (projectId === null) {
      addStandalone.mutate({
        source: "overleaf",
        url: url.trim(),
        token: needsToken ? token.trim() : null,
      })
      return
    }
    addOverleaf.mutate({
      projectId,
      url: url.trim(),
      ...(needsToken ? { token: token.trim() } : {}),
    })
  }
  const canSubmit =
    !busy && tokenStatus.isSuccess && url.trim() !== "" && (!needsToken || token.trim() !== "")

  return (
    <div data-testid="paper-setup" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div
        data-testid="paper-setup-content"
        className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6"
      >
        <div className="flex flex-col items-center gap-1 text-center">
          <h2 className="font-semibold text-foreground text-sm">{t("Choose a paper folder")}</h2>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t("Clone from Overleaf, open a folder, or start a new paper.")}
          </p>
        </div>
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
                <h3 className={cardTitleClass}>{t("Overleaf folders found in this project")}</h3>
                <p className={cardTextClass}>{t("Choose the paper folder.")}</p>
                <div className="flex flex-wrap gap-2">
                  {clones.map((clone) => (
                    <button
                      key={clone.dir}
                      type="button"
                      data-testid="paper-detected-option"
                      disabled={busy}
                      onClick={() => {
                        setError(null)
                        if (projectId !== null) {
                          link.mutate({ projectId, dir: clone.dir, rootChoice: null })
                        }
                      }}
                      className="rounded border border-border px-3 py-1.5 font-mono text-xs hover:bg-accent disabled:opacity-50"
                    >
                      {clone.relPath === "." ? t("Project folder (.)") : clone.relPath}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            {/* Grid items stretch, so the three cards have the same height (stacked when narrow). */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <section data-testid="paper-setup-overleaf" className={cardClass}>
                <div className="flex items-center gap-2">
                  <GitBranch className="size-4 text-muted-foreground" aria-hidden />
                  <h3 className={cardTitleClass}>{t("Add Overleaf project")}</h3>
                </div>
                <Input
                  data-testid="paper-overleaf-url"
                  aria-label={t("Overleaf Git URL")}
                  placeholder={t("Overleaf Git URL")}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
                {needsToken ? (
                  <Input
                    data-testid="paper-overleaf-token"
                    type="password"
                    aria-label={t("Overleaf Git token")}
                    placeholder={t("Overleaf Git token")}
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                  />
                ) : tokenFromGit ? (
                  <p data-testid="paper-overleaf-token-found" className={cardTextClass}>
                    {t("Overleaf Git detected")}
                  </p>
                ) : null}
                {needsToken ? (
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                    {/* A new-window link is handed to the user's browser by the main process. */}
                    <a href={TOKEN_URL} target="_blank" rel="noreferrer" className={linkClass}>
                      {t("Get a Git token")}
                    </a>
                    <a href={DOCS_URL} target="_blank" rel="noreferrer" className={linkClass}>
                      {t("How Overleaf Git works")}
                    </a>
                  </div>
                ) : null}
                <div className="mt-auto">
                  <Button
                    type="button"
                    size="sm"
                    data-testid="paper-overleaf-add"
                    disabled={!canSubmit}
                    onClick={submit}
                  >
                    {addOverleaf.isPending || (addStandalone.isPending && url.trim() !== "")
                      ? t("Cloning…")
                      : t("Add Overleaf project")}
                  </Button>
                </div>
              </section>

              <section data-testid="paper-setup-folder" className={cardClass}>
                <div className="flex items-center gap-2">
                  <FolderOpen className="size-4 text-muted-foreground" aria-hidden />
                  <h3 className={cardTitleClass}>{t("Use an existing folder")}</h3>
                </div>
                <div className="mt-auto">
                  <Button
                    type="button"
                    size="sm"
                    data-testid="paper-use-folder"
                    disabled={busy}
                    onClick={chooseFolder}
                  >
                    {t("Open folder…")}
                  </Button>
                </div>
              </section>

              <section data-testid="paper-setup-create" className={cardClass}>
                <div className="flex items-center gap-2">
                  <FilePlus className="size-4 text-muted-foreground" aria-hidden />
                  <h3 className={cardTitleClass}>{t("Start draft")}</h3>
                </div>
                {/* The folder wraps onto more lines when it is long; it is never cut. */}
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                  <span
                    data-testid="paper-create-folder"
                    title={createDir ?? createTarget.data?.dir ?? standaloneTarget.data?.dir}
                    className="min-w-0 font-mono wrap-anywhere"
                  >
                    {createDir ??
                      (standalone
                        ? standaloneTarget.data
                          ? `${display(standaloneTarget.data.dir)}/`
                          : ""
                        : createTarget.data
                          ? `${createTarget.data.displayDir}/`
                          : "")}
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
                <div className="mt-auto">
                  <Button
                    type="button"
                    size="sm"
                    data-testid="paper-create"
                    disabled={busy || (!standalone && createInto === null)}
                    onClick={() => {
                      setError(null)
                      if (projectId === null) createStandalone.mutate()
                      else if (createInto !== null) create.mutate({ projectId, dir: createInto })
                    }}
                  >
                    {creating
                      ? createStep === "building"
                        ? t("Building PDF…")
                        : t("Starting…")
                      : t("Start draft")}
                  </Button>
                </div>
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
      {destination.dialog}
    </div>
  )
}
