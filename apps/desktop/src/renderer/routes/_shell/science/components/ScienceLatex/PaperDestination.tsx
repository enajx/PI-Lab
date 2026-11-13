import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { Input } from "@pi-lab/ui"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type ReactNode, useState } from "react"
import { useTranslate } from "../../../../../i18n/language"
import { useDisplayPath } from "../../../../../trpc/displayPath"
import { useTRPC, useTRPCClient } from "../../../../../trpc/react"
import { DialogError, PaperDialog } from "./PaperSyncBar"

const buttonClass = "rounded border border-border px-3 py-1.5 text-sm hover:bg-accent"
const primaryClass =
  "rounded bg-primary px-3 py-1.5 text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50"

/** The parent folder of a `/`-separated path (display form or absolute). */
export function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "")
  const cut = trimmed.lastIndexOf("/")
  return cut <= 0 ? trimmed : trimmed.slice(0, cut)
}

interface Question {
  dir: string
  answer: (dir: string | null) => void
}

/**
 * Where a paper added with no project goes (Add Overleaf project and Start
 * draft). `ask(url)` gets the proposed folder, `<papers folder>/<name>` from
 * `paper.standaloneTarget`. With "Ask where to put new papers" on in Settings
 * it shows a dialog with that folder (shown with `~`), which the user can type
 * over or choose with Change…, and "Always put new papers in <folder>" to stop
 * asking (that saves the parent folder as the papers folder). Resolves to the
 * folder, or null when the user cancels. The caller renders `dialog`.
 */
export function usePaperDestination(): {
  ask: (url: string | null) => Promise<string | null>
  dialog: ReactNode
} {
  const t = useTranslate()
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const display = useDisplayPath()
  const settings = useQuery(trpc.settings.get.queryOptions())
  const askFirst = (settings.data?.editor ?? DEFAULT_EDITOR_SETTINGS).askPapersFolder
  const [question, setQuestion] = useState<Question | null>(null)

  const ask = async (url: string | null): Promise<string | null> => {
    const { dir } = await client.paper.standaloneTarget.query({ url })
    if (!askFirst) return dir
    return new Promise((answer) => setQuestion({ dir: display(dir), answer }))
  }

  const dialog = question ? (
    <DestinationDialog
      initial={question.dir}
      onAnswer={async (dir, remember) => {
        if (dir !== null && remember) {
          await client.settings.updateEditor.mutate({
            papersFolder: parentOf(dir),
            askPapersFolder: false,
          })
          void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
        }
        setQuestion(null)
        question.answer(dir)
      }}
      pickFolder={() => client.system.pickDirectory.mutate()}
      display={display}
      t={t}
    />
  ) : null
  return { ask, dialog }
}

function DestinationDialog({
  initial,
  onAnswer,
  pickFolder,
  display,
  t,
}: {
  initial: string
  onAnswer: (dir: string | null, remember: boolean) => Promise<void>
  pickFolder: () => Promise<string | null>
  display: (path: string) => string
  t: (english: string) => string
}) {
  const [dir, setDir] = useState(initial)
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = dir.trim()
  return (
    <PaperDialog
      testId="paper-destination-dialog"
      title={t("Where should the paper go?")}
      onClose={() => void onAnswer(null, false)}
    >
      <p className="mt-2 text-muted-foreground text-xs">
        {t("PI Lab makes this folder for the paper. It must be new or empty.")}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Input
          data-testid="paper-destination-dir"
          aria-label={t("Paper folder")}
          className="font-mono text-xs"
          value={dir}
          onChange={(event) => setDir(event.target.value)}
        />
        <button
          type="button"
          data-testid="paper-destination-change"
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
      <label className="mt-3 flex items-center gap-2 text-muted-foreground text-xs">
        <input
          type="checkbox"
          data-testid="paper-destination-remember"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        />
        {t("Always put new papers in")} <span className="font-mono">{parentOf(chosen)}</span>
        {t(", don't ask again")}
      </label>
      <DialogError error={error} />
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          data-testid="paper-destination-cancel"
          className={buttonClass}
          onClick={() => void onAnswer(null, false)}
        >
          {t("Cancel")}
        </button>
        <button
          type="button"
          data-testid="paper-destination-ok"
          disabled={chosen === ""}
          className={primaryClass}
          onClick={() => {
            onAnswer(chosen, remember).then(undefined, (cause: Error) => setError(cause.message))
          }}
        >
          {t("Continue")}
        </button>
      </div>
    </PaperDialog>
  )
}
