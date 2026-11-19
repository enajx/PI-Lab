import { describe, expect, it } from "vitest"
import {
  DICTATION_CAPABILITY,
  type DictationState,
  dictationAvailability,
  dictationStep,
  insertDictated,
} from "./dictation"

const idle: DictationState = { kind: "idle", attempt: 0 }

describe("dictation state machine", () => {
  it("records on the first press, transcribes on the second, then inserts the text", () => {
    const starting = dictationStep(idle, { type: "press" })
    expect(starting).toEqual({ state: { kind: "starting", attempt: 1 }, insert: null })
    const recording = dictationStep(starting.state, { type: "started", attempt: 1 })
    expect(recording.state).toEqual({ kind: "recording", attempt: 1 })
    const transcribing = dictationStep(recording.state, { type: "press" })
    expect(transcribing.state).toEqual({ kind: "transcribing", attempt: 1 })
    expect(
      dictationStep(transcribing.state, { type: "transcribed", attempt: 1, text: "Refactor it" }),
    ).toEqual({ state: { kind: "idle", attempt: 1 }, insert: "Refactor it" })
  })

  it("cancel while recording or transcribing drops the result of that attempt", () => {
    const recording: DictationState = { kind: "recording", attempt: 3 }
    expect(dictationStep(recording, { type: "cancel" }).state).toEqual({ kind: "idle", attempt: 3 })
    const transcribing: DictationState = { kind: "transcribing", attempt: 3 }
    const cancelled = dictationStep(transcribing, { type: "cancel" }).state
    expect(dictationStep(cancelled, { type: "transcribed", attempt: 3, text: "late" })).toEqual({
      state: cancelled,
      insert: null,
    })
    // A new attempt ignores the old one's late answer too.
    const again = dictationStep(cancelled, { type: "press" }).state
    expect(dictationStep(again, { type: "failed", attempt: 3, message: "late" }).state).toEqual(
      again,
    )
  })

  it("shows a failure, and a press after it starts a new recording", () => {
    const failed = dictationStep(
      { kind: "transcribing", attempt: 2 },
      { type: "failed", attempt: 2, message: "No speech was detected" },
    ).state
    expect(failed).toEqual({ kind: "error", attempt: 2, message: "No speech was detected" })
    expect(dictationStep(failed, { type: "press" }).state).toEqual({ kind: "starting", attempt: 3 })
    expect(dictationStep(failed, { type: "cancel" }).state).toEqual({ kind: "idle", attempt: 2 })
  })

  it("a failure to start the recorder (permission refused) is shown", () => {
    expect(
      dictationStep(
        { kind: "starting", attempt: 1 },
        { type: "failed", attempt: 1, message: "Microphone access was refused" },
      ).state,
    ).toEqual({ kind: "error", attempt: 1, message: "Microphone access was refused" })
  })

  it("ignores a press while starting or transcribing", () => {
    const starting: DictationState = { kind: "starting", attempt: 1 }
    expect(dictationStep(starting, { type: "press" }).state).toBe(starting)
    const transcribing: DictationState = { kind: "transcribing", attempt: 1 }
    expect(dictationStep(transcribing, { type: "press" }).state).toBe(transcribing)
  })
})

describe("insertDictated", () => {
  it("adds the text after the draft with one space", () => {
    expect(insertDictated("", "Hello")).toBe("Hello")
    expect(insertDictated("Please", "run it")).toBe("Please run it")
    expect(insertDictated("Please ", "run it")).toBe("Please run it")
    expect(insertDictated("Line\n", "next")).toBe("Line\nnext")
  })
})

describe("dictationAvailability", () => {
  const status = (bundled: boolean, selected: string | null, installed: boolean) => ({
    engine: { bundled },
    selectedModel: selected,
    models: [{ key: "small.en", installed }],
  })

  it("hides the mic without the capability, before the status, or without an engine", () => {
    expect(dictationAvailability(null, status(true, "small.en", true))).toBe("hidden")
    expect(dictationAvailability(["screen-text"], status(true, "small.en", true))).toBe("hidden")
    expect(dictationAvailability([DICTATION_CAPABILITY], null)).toBe("hidden")
    expect(dictationAvailability([DICTATION_CAPABILITY], status(false, "small.en", true))).toBe(
      "hidden",
    )
  })

  it("is ready with a selected, installed model, else says no model", () => {
    expect(dictationAvailability([DICTATION_CAPABILITY], status(true, "small.en", true))).toBe(
      "ready",
    )
    expect(dictationAvailability([DICTATION_CAPABILITY], status(true, null, false))).toBe(
      "no-model",
    )
    expect(dictationAvailability([DICTATION_CAPABILITY], status(true, "small.en", false))).toBe(
      "no-model",
    )
  })
})
