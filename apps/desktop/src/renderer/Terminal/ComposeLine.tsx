import { type KeyboardEvent, useRef, useState } from "react"
import { useTranslate } from "../i18n/language"

interface ComposeLineProps {
  /** Send one message; resolves once the server replied (it resends a lost reply itself). */
  send: (text: string) => Promise<void>
  /** Move the focus back to the terminal (Escape). */
  focusTerminal: () => void
}

/**
 * An input line under a terminal, for typing to an agent over a slow link:
 * the text is sent as one message (`terminal.sendMessage`) instead of key by
 * key. Enter sends, Shift+Enter adds a line, Up and Down recall the messages
 * sent from this pane (Up on the first line, Down on the last), paste is plain
 * text (a textarea takes only text), Escape goes back to the terminal (other keys such as Ctrl+C go to the
 * terminal when it has the focus). A message shows "Sending" until the reply.
 */
export function ComposeLine({ send, focusTerminal }: ComposeLineProps) {
  const t = useTranslate()
  const [text, setText] = useState("")
  const [sending, setSending] = useState<{ id: number; text: string }[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const history = useRef<string[]>([])
  /** Position in the history while recalling; equal to its length when not recalling. */
  const recall = useRef(0)
  const nextId = useRef(0)

  const submit = (): void => {
    if (text.length === 0) return
    const message = text
    const id = nextId.current++
    history.current.push(message)
    recall.current = history.current.length
    setText("")
    setFailure(null)
    setSending((current) => [...current, { id, text: message }])
    send(message).then(
      () => setSending((current) => current.filter((entry) => entry.id !== id)),
      (error: unknown) => {
        setSending((current) => current.filter((entry) => entry.id !== id))
        setFailure(error instanceof Error ? error.message : String(error))
        setText(message)
      },
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const area = event.currentTarget
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    } else if (event.key === "Escape") {
      event.preventDefault()
      focusTerminal()
    } else if (
      event.key === "ArrowUp" &&
      !area.value.slice(0, area.selectionStart).includes("\n")
    ) {
      if (recall.current === 0) return
      event.preventDefault()
      recall.current -= 1
      setText(history.current[recall.current] ?? "")
    } else if (event.key === "ArrowDown" && !area.value.slice(area.selectionEnd).includes("\n")) {
      if (recall.current >= history.current.length) return
      event.preventDefault()
      recall.current += 1
      setText(history.current[recall.current] ?? "")
    }
  }

  return (
    <div
      data-testid="terminal-compose"
      className="flex shrink-0 flex-col gap-1 border-t px-2 py-1.5"
    >
      {sending.map((entry) => (
        <div
          key={entry.id}
          data-testid="terminal-compose-sending"
          className="truncate text-muted-foreground text-xs"
        >
          {`${t("Sending")}: ${entry.text}`}
        </div>
      ))}
      {failure !== null ? (
        <div role="alert" className="text-destructive text-xs">
          {`${t("Message not sent")}: ${failure}`}
        </div>
      ) : null}
      <textarea
        data-testid="terminal-compose-input"
        aria-label={t("Message to the terminal")}
        placeholder={t("Message (Enter sends, Shift+Enter adds a line)")}
        rows={Math.min(6, Math.max(1, text.split("\n").length))}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className="w-full resize-none rounded-md border border-border bg-background px-2 py-1 font-mono text-foreground text-sm outline-none"
      />
    </div>
  )
}
