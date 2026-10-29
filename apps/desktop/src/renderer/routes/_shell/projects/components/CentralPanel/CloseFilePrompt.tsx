import { Button } from "@pi-lab/ui"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslate } from "../../../../../i18n/language"
import { registerCloseTabHandler } from "../../../../../shortcuts/closeTab"
import type { ActiveRef, CentralPanelController } from "./useCentralPanel"

/** The file tab Cmd+W closes: the focused file, unless the Run tab or a session has focus. */
export function fileTabToClose(active: ActiveRef | null, runFocused: boolean): string | null {
  if (runFocused || active?.type !== "file") return null
  return active.relPath
}

interface CloseFilePromptArgs {
  controller: CentralPanelController
  runFocused: boolean
  /** Opens the save-location chooser for an untitled buffer. */
  onSaveUntitled: ((relPath: string) => void) | undefined
}

export interface CloseFilePromptState {
  relPath: string
  busy: boolean
  error: string | null
}

/**
 * User close actions for project-view file tabs (tab ×, Ctrl+W, and macOS Cmd+W
 * from the native menu): a saved file closes at once, a dirty one opens the
 * unsaved-changes prompt. For Cmd+W, anything other than a focused file tab is
 * left to main, which moves the app to the background. Closes that the user
 * already confirmed elsewhere (deleting the file) call `controller.closeFile`
 * directly and never prompt.
 */
export function useCloseFilePrompt({
  controller,
  runFocused,
  onSaveUntitled,
}: CloseFilePromptArgs) {
  const { editor, active, closeFile } = controller
  const [prompt, setPrompt] = useState<CloseFilePromptState | null>(null)
  const latest = useRef({ active, runFocused, tabs: editor.tabs, closeFile, prompt })
  latest.current = { active, runFocused, tabs: editor.tabs, closeFile, prompt }

  /** Close one file tab, asking first when it has unsaved changes. */
  const requestClose = useCallback((relPath: string): void => {
    const current = latest.current
    // The prompt is already asking about a file: another close request waits for it.
    if (current.prompt) return
    if (current.tabs.find((tab) => tab.relPath === relPath)?.dirty) {
      setPrompt({ relPath, busy: false, error: null })
    } else {
      current.closeFile(relPath)
    }
  }, [])

  useEffect(
    () =>
      registerCloseTabHandler(() => {
        const current = latest.current
        // The prompt is already asking about a file: Cmd+W does nothing more.
        if (current.prompt) return true
        const relPath = fileTabToClose(current.active, current.runFocused)
        if (!relPath) return false
        requestClose(relPath)
        return true
      }),
    [requestClose],
  )

  const choose = async (choice: "save" | "discard" | "cancel"): Promise<void> => {
    if (!prompt || prompt.busy) return
    const { relPath } = prompt
    if (choice === "cancel") {
      setPrompt(null)
      return
    }
    if (choice === "discard") {
      setPrompt(null)
      closeFile(relPath)
      return
    }
    if (editor.buffers.find((buffer) => buffer.relPath === relPath)?.untitled) {
      if (!onSaveUntitled) {
        setPrompt({ relPath, busy: false, error: `Could not save ${relPath}: no save location.` })
        return
      }
      // The untitled file stays open while its save location is chosen.
      setPrompt(null)
      onSaveUntitled(relPath)
      return
    }
    setPrompt({ relPath, busy: true, error: null })
    const result = await editor.saveFile(relPath).then(
      (saved) => (saved ? null : `Could not save ${relPath}. The file stays open.`),
      (cause: unknown) =>
        `Could not save ${relPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    if (result !== null) {
      setPrompt({ relPath, busy: false, error: result })
      return
    }
    // Edits typed while saving are not on disk yet: keep the file and ask again.
    const after = editor.bufferAccess.read().find((buffer) => buffer.relPath === relPath)
    if (after && after.content !== after.savedContent) {
      setPrompt({ relPath, busy: false, error: `${relPath} changed while saving.` })
      return
    }
    setPrompt(null)
    closeFile(relPath)
  }

  return { prompt, choose, requestClose }
}

/** Save / Discard / Cancel prompt for closing one dirty file tab. */
export function CloseFilePrompt({
  prompt,
  onChoose,
}: {
  prompt: CloseFilePromptState
  onChoose: (choice: "save" | "discard" | "cancel") => void
}) {
  const t = useTranslate()
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-background/60 pt-[15vh]">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-file-title"
        data-testid="close-file-prompt"
        className="w-[min(34rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-5 shadow-xl"
      >
        <h2 id="close-file-title" className="font-semibold">
          {t("Unsaved changes")}
        </h2>
        <p className="mt-2 text-sm">
          {t("Save changes before closing this file?")} <code>{prompt.relPath}</code>
        </p>
        {prompt.error ? (
          <p role="alert" className="my-3 text-destructive text-sm">
            {prompt.error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" disabled={prompt.busy} onClick={() => onChoose("cancel")}>
            {t("Cancel")}
          </Button>
          <Button variant="ghost" disabled={prompt.busy} onClick={() => onChoose("discard")}>
            {t("Discard")}
          </Button>
          <Button disabled={prompt.busy} onClick={() => onChoose("save")}>
            {prompt.busy ? t("Saving…") : t("Save")}
          </Button>
        </div>
      </section>
    </div>
  )
}
