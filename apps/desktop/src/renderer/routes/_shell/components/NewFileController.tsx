import { Button } from "@pi-lab/ui"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
} from "react"
import { translateKnownError } from "../../../i18n/errors"
import { useInterfaceLanguage, useTranslate } from "../../../i18n/language"
import { useTRPC } from "../../../trpc/react"

export interface NewFileResult {
  projectId: string
  relPath: string
}

export interface NewFileRequest {
  onCreated: (created: NewFileResult) => void
  onCancel?: () => void
  /** Project already in context when the save request started. */
  initialProjectId?: string
}

interface NewFileController {
  openNewFile: (request: NewFileRequest) => void
  chooseNewFile: (projectId: string) => Promise<NewFileResult | null>
}

const NewFileControllerContext = createContext<NewFileController | null>(null)

/**
 * App-global project/path flow for creating a file. The file is created in a
 * project's main workspace before the caller navigates, so PI Lab never mounts
 * an editor outside the project view.
 */
export function NewFileControllerProvider({ children }: { children: ReactNode }) {
  const t = useTranslate()
  const [language] = useInterfaceLanguage()
  const trpc = useTRPC()
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())
  const [request, setRequest] = useState<NewFileRequest | null>(null)
  const [projectId, setProjectId] = useState("")
  const [relPath, setRelPath] = useState("")
  const titleId = useId()
  const ensureMain = useMutation(trpc.workspaces.ensureMain.mutationOptions())
  const createFile = useMutation(trpc.files.createFile.mutationOptions())
  const open = request !== null
  const pending = ensureMain.isPending || createFile.isPending
  const error = projectsQuery.error ?? ensureMain.error ?? createFile.error

  const close = (): void => {
    if (pending) return
    request?.onCancel?.()
    setRequest(null)
  }
  const chooseNewFile = useCallback(
    (initialProjectId: string): Promise<NewFileResult | null> =>
      new Promise((resolve) => {
        setRequest({ initialProjectId, onCreated: resolve, onCancel: () => resolve(null) })
      }),
    [],
  )

  useEffect(() => {
    if (open) return
    setProjectId("")
    setRelPath("")
    ensureMain.reset()
    createFile.reset()
  }, [open, ensureMain.reset, createFile.reset])

  useEffect(() => {
    if (!open) return
    setProjectId(request.initialProjectId ?? "")
  }, [open, request])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !pending) {
        request?.onCancel?.()
        setRequest(null)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open, pending, request])

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const path = relPath.trim()
    if (!projectId || !path || pending) return
    ensureMain.mutate(
      { projectId },
      {
        onSuccess: (workspace) => {
          createFile.mutate(
            { workspaceId: workspace.id, relPath: path },
            {
              onSuccess: (created) => {
                request?.onCreated({ projectId, relPath: created.relPath })
                setRequest(null)
              },
            },
          )
        },
      },
    )
  }

  return (
    <NewFileControllerContext.Provider value={{ openNewFile: setRequest, chooseNewFile }}>
      {children}
      {open ? (
        <div
          data-testid="new-file-backdrop"
          className="fixed inset-0 z-[60] flex items-start justify-center bg-background/45 pt-[12vh] backdrop-blur-[1px]"
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            data-testid="new-file-dialog"
            className="flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-4 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-xl"
            onSubmit={submit}
          >
            <div>
              <h2 id={titleId} className="font-semibold text-sm">
                {t("New file")}
              </h2>
              <p className="mt-1 text-muted-foreground text-xs">
                {t("Choose a project and create a relative path inside it.")}
              </p>
            </div>

            {projectsQuery.isError ? null : projectsQuery.isPending ? (
              <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-muted-foreground text-xs">
                {t("Loading projects…")}
              </p>
            ) : projectsQuery.data?.length === 0 ? (
              <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-muted-foreground text-xs">
                {t("Add a project before creating a file.")}
              </p>
            ) : (
              <>
                <label className="flex flex-col gap-1.5 font-medium text-xs">
                  {t("Project")}
                  <select
                    value={projectId}
                    onChange={(event) => setProjectId(event.target.value)}
                    disabled={pending}
                    className="rounded-md border border-border bg-background px-2 py-2 font-normal text-sm outline-none focus:border-ring"
                  >
                    <option value="">{t("Choose a project…")}</option>
                    {(projectsQuery.data ?? []).map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                        {project.archivedAt ? ` (${t("hidden")})` : ""} — {project.repoPath}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1.5 font-medium text-xs">
                  {t("File name")}
                  <input
                    type="text"
                    value={relPath}
                    onChange={(event) => setRelPath(event.target.value)}
                    disabled={pending}
                    placeholder="notes/idea.md"
                    className="rounded-md border border-border bg-background px-2 py-2 font-normal text-sm outline-none focus:border-ring"
                  />
                </label>
              </>
            )}

            {error ? (
              <p role="alert" className="cursor-text select-text text-destructive text-xs">
                {translateKnownError(language, error.message)}
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={pending} onClick={close}>
                {t("Cancel")}
              </Button>
              <Button
                type="submit"
                disabled={
                  pending ||
                  projectsQuery.isPending ||
                  projectsQuery.isError ||
                  projectsQuery.data?.length === 0 ||
                  !projectId ||
                  relPath.trim().length === 0
                }
              >
                {pending ? t("Creating…") : t("Create and open")}
              </Button>
            </div>
          </form>
        </div>
      ) : null}
    </NewFileControllerContext.Provider>
  )
}

export function useNewFileController(): NewFileController {
  const controller = useContext(NewFileControllerContext)
  if (!controller) {
    throw new Error("useNewFileController must be used within NewFileControllerProvider")
  }
  return controller
}

/** The isolated project-workspace tests mount without the shell providers. */
export function useOptionalNewFileController(): NewFileController | null {
  return useContext(NewFileControllerContext)
}
