import { Button } from "@pi-lab/ui"
import { useCallback, useRef, useState } from "react"
import { useTranslate } from "../../../../../i18n/language"

/** An agent, terminal or notebook tab (or the Run tab) that a close request would stop. */
export interface CloseSessionTarget {
  kind: "agent" | "terminal" | "notebook"
  label: string
  /** Close the tab and stop its process (the same close the tab × runs). */
  close: () => void
}

/**
 * Cmd+W and Ctrl+W on an agent or terminal tab, and any close of a notebook tab:
 * closing it stops the process (a notebook's server, with its unsaved edits), so
 * the prompt asks first. One prompt at a time; requests while it is open wait.
 */
export function useCloseSessionPrompt() {
  const [prompt, setPrompt] = useState<CloseSessionTarget | null>(null)
  const latest = useRef(prompt)
  latest.current = prompt

  /** Ask before closing `target`; ignored while a prompt is already open. */
  const requestClose = useCallback((target: CloseSessionTarget): void => {
    if (latest.current) return
    latest.current = target
    setPrompt(target)
  }, [])

  const choose = (choice: "close" | "cancel"): void => {
    const target = latest.current
    if (!target) return
    latest.current = null
    setPrompt(null)
    if (choice === "close") target.close()
  }

  return { prompt, requestClose, choose }
}

const PROMPT_TEXT = {
  agent: { title: "Stop agent?", body: "Closing this tab stops the agent.", close: "Stop agent" },
  terminal: {
    title: "Close terminal?",
    body: "Closing this tab stops the terminal and anything running in it.",
    close: "Close terminal",
  },
  notebook: {
    title: "Close notebook?",
    body: "Save the notebook in its tab first; closing stops its server.",
    close: "Close",
  },
} as const

/** Cancel / Stop agent (Close terminal, Close notebook) prompt for closing one tab. */
export function CloseSessionPrompt({
  prompt,
  onChoose,
}: {
  prompt: CloseSessionTarget
  onChoose: (choice: "close" | "cancel") => void
}) {
  const t = useTranslate()
  const text = PROMPT_TEXT[prompt.kind]
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-background/60 pt-[15vh]">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-session-title"
        data-testid="close-session-prompt"
        className="w-[min(34rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-5 shadow-xl"
      >
        <h2 id="close-session-title" className="font-semibold">
          {t(text.title)}
        </h2>
        <p className="mt-2 text-sm">
          {t(text.body)} <code>{prompt.label}</code>
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onChoose("cancel")}>
            {t("Cancel")}
          </Button>
          <Button
            variant="destructive"
            data-testid="close-session-confirm"
            onClick={() => onChoose("close")}
          >
            {t(text.close)}
          </Button>
        </div>
      </section>
    </div>
  )
}
