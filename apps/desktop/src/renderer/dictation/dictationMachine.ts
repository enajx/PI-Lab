/**
 * The dictation overlay's states and the moves between them, as a pure reducer. The
 * controller ({@link ./DictationController}) runs the side effects (microphone, download,
 * transcription) and reports their results here as events.
 */

export type OutputAction = "insert" | "review" | "insert-copy" | "copy"

/** What the error pill offers as its button. */
export type ErrorAction = "open-microphone-settings" | "choose-model" | "none"

export type DictationState =
  | { phase: "idle" }
  /** First use without an installed model: the local-only explanation and download offer. */
  | { phase: "prompt" }
  | { phase: "downloading" }
  | { phase: "listening" }
  /** Recording stopped and the local engine is still loading the model. */
  | { phase: "loading" }
  | { phase: "transcribing" }
  | { phase: "review"; text: string }
  | { phase: "copied" }
  | { phase: "error"; message: string; action: ErrorAction }

export type DictationEvent =
  /** The dictation shortcut. */
  | { type: "toggle"; modelInstalled: boolean; engineReady: boolean }
  | { type: "enter"; engineReady: boolean }
  /** Esc: discard whatever is in progress. */
  | { type: "cancel" }
  | { type: "download-started" }
  | { type: "download-complete" }
  | { type: "download-cancelled" }
  | { type: "engine-ready" }
  | { type: "transcribed"; text: string; outputAction: OutputAction }
  | { type: "review-done" }
  | { type: "copied-done" }
  | { type: "fail"; message: string; action: ErrorAction }

const IDLE: DictationState = { phase: "idle" }

/** Move to the next state. Events that do not apply to the current state leave it unchanged. */
export function dictationReducer(state: DictationState, event: DictationEvent): DictationState {
  if (event.type === "cancel") return IDLE
  if (event.type === "fail") {
    return state.phase === "idle"
      ? state
      : { phase: "error", message: event.message, action: event.action }
  }
  switch (state.phase) {
    case "idle":
      if (event.type !== "toggle") return state
      return event.modelInstalled ? { phase: "listening" } : { phase: "prompt" }
    case "prompt":
      if (event.type === "toggle") return IDLE
      if (event.type === "download-started") return { phase: "downloading" }
      return state
    case "downloading":
      if (event.type === "download-complete") return { phase: "listening" }
      if (event.type === "download-cancelled") return IDLE
      return state
    case "listening":
      if (event.type !== "toggle" && event.type !== "enter") return state
      return event.engineReady ? { phase: "transcribing" } : { phase: "loading" }
    case "loading":
      return event.type === "engine-ready" ? { phase: "transcribing" } : state
    case "transcribing":
      if (event.type !== "transcribed") return state
      if (event.text.trim() === "") {
        return { phase: "error", message: "No speech was heard.", action: "none" }
      }
      if (event.outputAction === "review") return { phase: "review", text: event.text }
      if (event.outputAction === "insert") return IDLE
      return { phase: "copied" }
    case "review":
      // The shortcut drops the reviewed text and starts a new dictation.
      if (event.type === "toggle") return { phase: "listening" }
      return event.type === "review-done" ? IDLE : state
    case "copied":
      return event.type === "copied-done" || event.type === "toggle" ? IDLE : state
    case "error":
      return event.type === "toggle" ? IDLE : state
  }
}

interface ModelChoice {
  key: string
  installed: boolean
  recommended: boolean
}

export type StartChoice = { kind: "listen" } | { kind: "select"; key: string } | { kind: "prompt" }

/**
 * What the shortcut does when idle: listen with the selected installed model; without
 * one, select the recommended model if it is installed; otherwise show the first-use prompt.
 */
export function startChoice(
  models: readonly ModelChoice[],
  selectedModel: string | null,
): StartChoice {
  if (models.some((entry) => entry.key === selectedModel && entry.installed))
    return { kind: "listen" }
  const recommended = models.find((entry) => entry.recommended && entry.installed)
  return recommended ? { kind: "select", key: recommended.key } : { kind: "prompt" }
}

/**
 * The first-use download of `key` was refused (another download runs, or it is installed).
 * "follow": the running download is this model, show its progress. "installed": the model
 * is installed now, use it. "other": a different model is downloading.
 */
export function afterRefusedDownload(
  status: {
    download: { state: string; modelKey: string | null }
    models: readonly ModelChoice[]
  },
  key: string,
): "follow" | "installed" | "other" {
  if (status.models.some((entry) => entry.key === key && entry.installed)) return "installed"
  const { download } = status
  const running = download.state === "downloading" || download.state === "verifying"
  return running && download.modelKey === key ? "follow" : "other"
}
