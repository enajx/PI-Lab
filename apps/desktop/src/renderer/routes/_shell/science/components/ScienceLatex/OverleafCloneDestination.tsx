import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { Input } from "@pi-lab/ui"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type ReactNode, useState } from "react"
import { useTranslate } from "../../../../../i18n/language"
import { useDisplayPath } from "../../../../../trpc/displayPath"
import { useTRPC, useTRPCClient } from "../../../../../trpc/react"
import { parentOf } from "./PaperDestination"
import { DialogError, PaperDialog } from "./PaperSyncBar"

const buttonClass = "rounded border border-border px-3 py-1.5 text-sm hover:bg-accent"
const primaryClass =
  "rounded bg-primary px-3 py-1.5 text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50"

/** Where the clone goes: null for `<project>/paper`, else the chosen folder. */
export interface CloneDestination {
  dir: string | null
}

interface Question {
  /** The project folder, shown with `~`. */
  projectDir: string
  /** The proposed other folder, shown with `~`. */
  otherDir: string
  answer: (destination: CloneDestination | null) => void
}

/**
 * Where Add Overleaf project clones a paper for an existing project. With the
 * remembered choice from Settings (`overleafCloneLocation`) it does not ask:
 * "project" is `<project>/paper` and "folder" is `<remembered folder>/<Overleaf
 * project id>` (`paper.cloneTarget`). With "ask" it shows a dialog: inside the
 * project (the default) or another folder (proposed in the papers folder, typed
 * over or chosen with Change…; the clone is made in that folder, which must be
 * new or empty), and "Remember my choice", which saves "project", or "folder"
 * with the chosen folder's parent, as the papers folder question does.
 * Resolves to the destination, or null when the user cancels. The caller
 * renders `dialog`.
 */
export function useOverleafCloneDestination(projectId: string): {
  ask: (url: string) => Promise<CloneDestination | null>
  dialog: ReactNode
} {
  const t = useTranslate()
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const display = useDisplayPath()
  const settings = useQuery(trpc.settings.get.queryOptions())
  const editor = settings.data?.editor ?? DEFAULT_EDITOR_SETTINGS
  const [question, setQuestion] = useState<Question | null>(null)

  const ask = async (url: string): Promise<CloneDestination | null> => {
    if (editor.overleafCloneLocation === "project") return { dir: null }
    if (editor.overleafCloneLocation === "folder") {
      const { dir } = await client.paper.cloneTarget.query({
        folder: editor.overleafCloneFolder,
        url,
      })
      return { dir }
    }
    const [project, proposed] = await Promise.all([
      client.projects.get.query({ id: projectId }),
      client.paper.standaloneTarget.query({ url }),
    ])
    return new Promise((answer) =>
      setQuestion({
        projectDir: display(project.repoPath),
        otherDir: display(proposed.dir),
        answer,
      }),
    )
  }

  const dialog = question ? (
    <CloneDialog
      projectDir={question.projectDir}
      otherDir={question.otherDir}
      onAnswer={async (destination, remember) => {
        if (destination !== null && remember) {
          await client.settings.updateEditor.mutate(
            destination.dir === null
              ? { overleafCloneLocation: "project" }
              : {
                  overleafCloneLocation: "folder",
                  overleafCloneFolder: parentOf(destination.dir),
                },
          )
          void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
        }
        setQuestion(null)
        question.answer(destination)
      }}
      pickFolder={() => client.system.pickDirectory.mutate()}
      display={display}
      t={t}
    />
  ) : null
  return { ask, dialog }
}

function CloneDialog({
  projectDir,
  otherDir,
  onAnswer,
  pickFolder,
  display,
  t,
}: {
  projectDir: string
  otherDir: string
  onAnswer: (destination: CloneDestination | null, remember: boolean) => Promise<void>
  pickFolder: () => Promise<string | null>
  display: (path: string) => string
  t: (english: string) => string
}) {
  const [inProject, setInProject] = useState(true)
  const [dir, setDir] = useState(otherDir)
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = dir.trim()
  return (
    <PaperDialog
      testId="overleaf-clone-dialog"
      title={t("Where should the Overleaf project be cloned?")}
      onClose={() => void onAnswer(null, false)}
    >
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input
          type="radio"
          name="overleaf-clone-location"
          data-testid="overleaf-clone-project"
          className="mt-1 shrink-0"
          checked={inProject}
          onChange={() => setInProject(true)}
        />
        <span className="flex min-w-0 flex-col">
          {t("Inside the project")}
          {/* A long path wraps onto more lines; it is never cut. */}
          <span className="font-mono text-muted-foreground text-xs wrap-anywhere">
            {`${projectDir}/paper`}
          </span>
        </span>
      </label>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="overleaf-clone-location"
          data-testid="overleaf-clone-folder"
          checked={!inProject}
          onChange={() => setInProject(false)}
        />
        {t("Another folder")}
      </label>
      {inProject ? null : (
        <>
          <p className="mt-2 text-muted-foreground text-xs">
            {t("PI Lab clones the paper into this folder. It must be new or empty.")}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Input
              data-testid="overleaf-clone-dir"
              aria-label={t("Paper folder")}
              className="font-mono text-xs"
              value={dir}
              onChange={(event) => setDir(event.target.value)}
            />
            <button
              type="button"
              data-testid="overleaf-clone-change"
              className={`${buttonClass} shrink-0`}
              onClick={() => {
                setError(null)
                pickFolder().then(
                  (picked) => {
                    if (picked) setDir(display(picked))
                  },
                  (cause: Error) => setError(cause.message),
                )
              }}
            >
              {t("Change…")}
            </button>
          </div>
        </>
      )}
      <label className="mt-3 flex items-center gap-2 text-muted-foreground text-xs">
        <input
          type="checkbox"
          data-testid="overleaf-clone-remember"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        />
        {t("Remember my choice")}
        {!inProject && remember && chosen !== "" ? (
          <span>
            {t("(next papers go in")}{" "}
            <span className="font-mono">{`${parentOf(chosen)}/<Overleaf id>`}</span>
            {")"}
          </span>
        ) : null}
      </label>
      <DialogError error={error} />
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          data-testid="overleaf-clone-cancel"
          className={buttonClass}
          onClick={() => void onAnswer(null, false)}
        >
          {t("Cancel")}
        </button>
        <button
          type="button"
          data-testid="overleaf-clone-ok"
          disabled={!inProject && chosen === ""}
          className={primaryClass}
          onClick={() => {
            onAnswer({ dir: inProject ? null : chosen }, remember).then(undefined, (cause: Error) =>
              setError(cause.message),
            )
          }}
        >
          {t("Continue")}
        </button>
      </div>
    </PaperDialog>
  )
}
