import type { DictationWaveformStyle } from "@pi-lab/local-db"
import { Button } from "@pi-lab/ui"
import { AudioLines, Check, CircleAlert, Lock } from "lucide-react"
import {
  type CSSProperties,
  type MouseEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { DownloadProgress } from "./DownloadProgress"
import type { DictationState, ErrorAction } from "./dictationMachine"
import { Waveform } from "./Waveform"
import "./dictation.css"

/** The model the first-use prompt offers. */
export interface PromptModel {
  name: string
  sizeLabel: string
}

interface DictationPillProps {
  state: Exclude<DictationState, { phase: "idle" }>
  /** The focused pane the pill sits on. */
  anchor: HTMLElement
  waveformStyle: DictationWaveformStyle
  /** Live microphone loudness (RMS) while listening. */
  level: () => number
  download: { receivedBytes: number; totalBytes: number } | null
  promptModel: PromptModel | null
  onDownload: () => void
  onChooseModel: () => void
  onCancelDownload: () => void
  onInsert: (text: string) => void
  onCopy: (text: string) => void
  onCloseReview: () => void
  onErrorAction: (action: ErrorAction) => void
  /** A click on the pill outside its own controls: cancel and open Settings > Dictation. */
  onOpenSettings: () => void
}

/** One-line local-only statement shown by the prompt, Settings and the setup wizard. */
export const LOCAL_ONLY_STATEMENT = "Runs fully local. Audio never leaves this Mac."

/**
 * The dictation overlay: a floating pill at the bottom center of the focused pane, with
 * one look and animation per state. The first-use prompt and review expand it to a card.
 * A click on the pill outside its buttons and text field opens Settings > Dictation.
 */
export function DictationPill(props: DictationPillProps) {
  const { state, anchor, onOpenSettings } = props
  const position = useAnchorPosition(anchor)
  const card = state.phase === "prompt" || state.phase === "review"
  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target instanceof Element && event.target.closest("button, textarea")) return
    onOpenSettings()
  }
  return (
    // A mouse shortcut on a status region. Keyboard users open Settings with Cmd+,.
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above
    // biome-ignore lint/a11y/noStaticElementInteractions: see above
    <div
      onClick={onClick}
      role={state.phase === "error" ? "alert" : "status"}
      aria-live="polite"
      data-testid="dictation-pill"
      data-phase={state.phase}
      data-shape={card ? "card" : "pill"}
      className="dictation-pill text-xs"
      style={position}
    >
      <PillBody {...props} />
    </div>
  )
}

function PillBody(props: DictationPillProps) {
  const { state } = props
  switch (state.phase) {
    case "prompt":
      return <FirstUsePrompt {...props} />
    case "downloading":
      return <Downloading {...props} />
    case "listening":
      return (
        <div className="flex items-center gap-3 py-2 ps-4 pe-3">
          <Waveform style={props.waveformStyle} level={props.level} />
          <span className="sr-only">Listening</span>
          <kbd
            className="dictation-kbd"
            title="Press Enter to transcribe"
            aria-label="Press Enter to transcribe"
          >
            ⏎
          </kbd>
        </div>
      )
    case "loading":
      return (
        <div className="flex items-center gap-2.5 px-4 py-2.5">
          <span className="dictation-dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          <span className="text-muted-foreground">Loading model</span>
          <Hints keys={["⎋"]} />
        </div>
      )
    case "transcribing":
      return (
        <div className="flex items-center gap-2.5 px-4 py-2">
          <span className="dictation-sweep" aria-hidden>
            <span />
            <span />
            <span />
            <span />
            <span />
          </span>
          <span className="dictation-shimmer-text font-medium">Transcribing</span>
          <Hints keys={["⎋"]} />
        </div>
      )
    case "review":
      return <Review {...props} text={state.text} />
    case "copied":
      return (
        <div className="flex items-center gap-2 px-4 py-2.5 font-medium">
          <Check className="dictation-check size-4 text-[var(--accent-brand)]" aria-hidden />
          Copied
        </div>
      )
    case "error":
      return (
        <div className="flex max-w-[34rem] items-center gap-2.5 py-2 ps-3.5 pe-2">
          <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
          <span className="min-w-0 text-foreground">{state.message}</span>
          {state.action !== "none" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => props.onErrorAction(state.action)}
            >
              {state.action === "open-microphone-settings"
                ? "Open System Settings"
                : "Choose a model"}
            </Button>
          ) : null}
          <Hints keys={["⎋"]} />
        </div>
      )
  }
}

function FirstUsePrompt({ promptModel, onDownload, onChooseModel }: DictationPillProps) {
  const download = useRef<HTMLButtonElement | null>(null)
  useEffect(() => download.current?.focus(), [])
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 font-medium text-foreground text-sm">
          <AudioLines className="size-4 text-[var(--accent-brand)]" aria-hidden />
          Set up dictation
        </div>
        <p className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
          <Lock className="size-3 shrink-0" aria-hidden />
          {LOCAL_ONLY_STATEMENT}
        </p>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onChooseModel}>
          Choose another model
        </Button>
        <Button
          ref={download}
          type="button"
          size="sm"
          disabled={!promptModel}
          data-testid="dictation-download-recommended"
          onClick={onDownload}
        >
          {promptModel ? `Download ${promptModel.name} (${promptModel.sizeLabel})` : "Download"}
        </Button>
      </div>
    </div>
  )
}

function Downloading({ download, onCancelDownload }: DictationPillProps) {
  const received = download?.receivedBytes ?? 0
  const total = download?.totalBytes ?? 0
  const percent = total > 0 ? Math.min(100, (received / total) * 100) : 0
  return (
    <div className="flex w-[19rem] items-center gap-3 py-2 ps-4 pe-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex justify-between text-muted-foreground">
          <span className="text-foreground">Downloading model</span>
          <span className="tabular-nums">
            {megabytes(received)} of {megabytes(total)} MB
          </span>
        </div>
        <DownloadProgress label="Model download" percent={percent} />
      </div>
      <Button type="button" size="sm" variant="ghost" onClick={onCancelDownload}>
        Cancel
      </Button>
    </div>
  )
}

function Review({ text, onInsert, onCopy, onCloseReview }: DictationPillProps & { text: string }) {
  const [draft, setDraft] = useState(text)
  const field = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const element = field.current
    if (!element) return
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
  }, [])
  return (
    <div className="flex w-[28rem] flex-col gap-2 p-3">
      <textarea
        ref={field}
        data-testid="dictation-review-text"
        aria-label="Transcribed text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault()
            onInsert(draft)
          } else if (event.key === "Escape") {
            event.preventDefault()
            onCloseReview()
          }
        }}
        rows={3}
        className="w-full resize-none rounded-lg border border-border bg-background px-2.5 py-2 text-foreground text-sm leading-relaxed outline-none focus:border-[var(--ring)]"
      />
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">
          <kbd className="dictation-kbd">↵</kbd> insert · <kbd className="dictation-kbd">⎋</kbd>{" "}
          close
        </span>
        <span className="flex-1" />
        <Button type="button" size="sm" variant="ghost" onClick={() => onCopy(draft)}>
          Copy
        </Button>
        <Button type="button" size="sm" onClick={() => onInsert(draft)}>
          Insert
        </Button>
      </div>
    </div>
  )
}

function Hints({ keys }: { keys: string[] }) {
  return (
    <span className="ms-1 flex items-center gap-1" aria-hidden>
      {keys.map((key) => (
        <kbd key={key} className="dictation-kbd">
          {key}
        </kbd>
      ))}
    </span>
  )
}

function megabytes(bytes: number): string {
  return Math.round(bytes / 1_000_000).toString()
}

/** Follow the anchor pane's bottom center as layout changes (splits, window resize). */
function useAnchorPosition(anchor: HTMLElement): CSSProperties {
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
  useLayoutEffect(() => {
    let frame = 0
    const measure = (): void => {
      const rect = anchor.getBoundingClientRect()
      const left = rect.left + rect.width / 2
      const top = rect.bottom - 16
      setPosition((current) =>
        current.left === left && current.top === top ? current : { left, top },
      )
      frame = requestAnimationFrame(measure)
    }
    measure()
    return () => cancelAnimationFrame(frame)
  }, [anchor])
  return position
}
