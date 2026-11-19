// Dictation in the reply box: tap the mic to record, tap again to stop; the
// server transcribes the audio and the text is added to the draft (never
// sent on its own). Every recording is one attempt; an answer for an older
// attempt (after a cancel) is dropped.

/** The server capability that announces phone dictation (`dictation.stream`). */
export const DICTATION_CAPABILITY = "dictation-stream"

export type DictationState =
  | { kind: "idle"; attempt: number }
  /** Asking for the microphone and starting the recorder. */
  | { kind: "starting"; attempt: number }
  | { kind: "recording"; attempt: number }
  | { kind: "transcribing"; attempt: number }
  | { kind: "error"; attempt: number; message: string }

export type DictationEvent =
  /** The mic button: start a recording, or stop the current one. */
  | { type: "press" }
  | { type: "started"; attempt: number }
  | { type: "cancel" }
  | { type: "transcribed"; attempt: number; text: string }
  | { type: "failed"; attempt: number; message: string }

/** The next state, and the text to add to the draft (null for none). */
export function dictationStep(
  state: DictationState,
  event: DictationEvent,
): { state: DictationState; insert: string | null } {
  const next = (value: DictationState) => ({ state: value, insert: null })
  const { attempt } = state
  if (event.type === "press") {
    if (state.kind === "idle" || state.kind === "error")
      return next({ kind: "starting", attempt: attempt + 1 })
    if (state.kind === "recording") return next({ kind: "transcribing", attempt })
    return next(state)
  }
  if (event.type === "cancel") return next({ kind: "idle", attempt })
  // Below: answers for one attempt; an older attempt's answer is dropped.
  if (event.attempt !== attempt) return next(state)
  if (event.type === "started")
    return next(state.kind === "starting" ? { kind: "recording", attempt } : state)
  if (state.kind !== "starting" && state.kind !== "transcribing" && state.kind !== "recording")
    return next(state)
  if (event.type === "failed") return next({ kind: "error", attempt, message: event.message })
  if (state.kind !== "transcribing") return next(state)
  return { state: { kind: "idle", attempt }, insert: event.text }
}

/** The draft with the dictated text added after it, separated by one space. */
export function insertDictated(draft: string, text: string): string {
  if (draft.length === 0 || /\s$/.test(draft)) return draft + text
  return `${draft} ${text}`
}

/** What `dictation.status` says that the mic needs. */
export interface DictationStatusView {
  engine: { bundled: boolean }
  selectedModel: string | null
  models: Array<{ key: string; installed: boolean }>
}

/**
 * "ready" shows the mic; "no-model" shows a note that a model must be
 * downloaded on the computer; "hidden" shows nothing (an older server, a
 * server without the engine, or the status not read yet).
 */
export function dictationAvailability(
  capabilities: string[] | null,
  status: DictationStatusView | null,
): "hidden" | "no-model" | "ready" {
  if (!capabilities?.includes(DICTATION_CAPABILITY) || !status?.engine.bundled) return "hidden"
  const selected = status.models.find((model) => model.key === status.selectedModel)
  return selected?.installed ? "ready" : "no-model"
}
