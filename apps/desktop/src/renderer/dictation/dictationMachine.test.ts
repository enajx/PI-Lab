import { describe, expect, test } from "vitest"
import {
  afterRefusedDownload,
  type DictationEvent,
  type DictationState,
  dictationReducer,
  startChoice,
} from "./dictationMachine"

const IDLE: DictationState = { phase: "idle" }

function run(events: DictationEvent[]): DictationState {
  return events.reduce(dictationReducer, IDLE)
}

const toggle = (modelInstalled: boolean, engineReady: boolean): DictationEvent => ({
  type: "toggle",
  modelInstalled,
  engineReady,
})

describe("dictation state machine", () => {
  test("toggle starts listening, toggle again transcribes, and insert returns to idle", () => {
    expect(run([toggle(true, false)])).toEqual({ phase: "listening" })
    expect(run([toggle(true, false), toggle(true, true)])).toEqual({ phase: "transcribing" })
    expect(
      run([
        toggle(true, true),
        toggle(true, true),
        { type: "transcribed", text: "hello", outputAction: "insert" },
      ]),
    ).toEqual(IDLE)
  })

  test("Enter also stops, and a model that is still loading shows loading first", () => {
    expect(run([toggle(true, false), { type: "enter", engineReady: false }])).toEqual({
      phase: "loading",
    })
    expect(
      run([toggle(true, false), { type: "enter", engineReady: false }, { type: "engine-ready" }]),
    ).toEqual({ phase: "transcribing" })
  })

  test("Enter does nothing outside listening", () => {
    expect(run([{ type: "enter", engineReady: true }])).toEqual(IDLE)
    expect(run([toggle(false, false), { type: "enter", engineReady: true }])).toEqual({
      phase: "prompt",
    })
  })

  test("Esc cancels from any state", () => {
    for (const events of [
      [toggle(true, false)],
      [toggle(true, true), toggle(true, true)],
      [toggle(false, false)],
      [toggle(false, false), { type: "download-started" } as const],
    ]) {
      expect(run([...events, { type: "cancel" }])).toEqual(IDLE)
    }
  })

  test("without a model, the prompt leads to downloading and then straight to listening", () => {
    const states = [
      toggle(false, false),
      { type: "download-started" } as const,
      { type: "download-complete" } as const,
    ]
    expect(run(states.slice(0, 1))).toEqual({ phase: "prompt" })
    expect(run(states.slice(0, 2))).toEqual({ phase: "downloading" })
    expect(run(states)).toEqual({ phase: "listening" })
    expect(run([...states.slice(0, 2), toggle(false, false)])).toEqual({ phase: "downloading" })
    expect(run([...states.slice(0, 2), { type: "download-cancelled" }])).toEqual(IDLE)
  })

  test("each output action picks the state after transcription", () => {
    const transcribed = (outputAction: "insert" | "review" | "insert-copy" | "copy") =>
      run([
        toggle(true, true),
        toggle(true, true),
        { type: "transcribed", text: "some words", outputAction },
      ])
    expect(transcribed("insert")).toEqual(IDLE)
    expect(transcribed("review")).toEqual({ phase: "review", text: "some words" })
    expect(transcribed("insert-copy")).toEqual({ phase: "copied" })
    expect(transcribed("copy")).toEqual({ phase: "copied" })
    expect(
      run([
        toggle(true, true),
        toggle(true, true),
        { type: "transcribed", text: "a", outputAction: "copy" },
        { type: "copied-done" },
      ]),
    ).toEqual(IDLE)
  })

  test("empty transcription shows a plain error instead of inserting nothing", () => {
    expect(
      run([
        toggle(true, true),
        toggle(true, true),
        { type: "transcribed", text: "  ", outputAction: "insert" },
      ]),
    ).toEqual({ phase: "error", message: "No speech was heard.", action: "none" })
  })

  test("a failure shows its message and action, and the shortcut closes it", () => {
    const failed = run([
      toggle(true, false),
      { type: "fail", message: "Microphone access is off.", action: "open-microphone-settings" },
    ])
    expect(failed).toEqual({
      phase: "error",
      message: "Microphone access is off.",
      action: "open-microphone-settings",
    })
    expect(dictationReducer(failed, toggle(true, true))).toEqual(IDLE)
    expect(dictationReducer(IDLE, { type: "fail", message: "late", action: "none" })).toEqual(IDLE)
  })

  test("review closes after insert or copy", () => {
    const review = run([
      toggle(true, true),
      toggle(true, true),
      { type: "transcribed", text: "draft", outputAction: "review" },
    ])
    expect(dictationReducer(review, { type: "review-done" })).toEqual(IDLE)
  })

  test("the shortcut in review discards the text and starts a new dictation", () => {
    const review = run([
      toggle(true, true),
      toggle(true, true),
      { type: "transcribed", text: "draft", outputAction: "review" },
    ])
    expect(dictationReducer(review, toggle(true, false))).toEqual({ phase: "listening" })
  })
})

const model = (key: string, installed: boolean, recommended: boolean) => ({
  key,
  installed,
  recommended,
})

describe("first use", () => {
  test("listens with the selected model, else selects an installed recommended model, else prompts", () => {
    const models = [model("tiny.en", true, false), model("small.en", true, true)]
    expect(startChoice(models, "tiny.en")).toEqual({ kind: "listen" })
    expect(startChoice(models, null)).toEqual({ kind: "select", key: "small.en" })
    expect(
      startChoice([model("tiny.en", true, false), model("small.en", false, true)], null),
    ).toEqual({ kind: "prompt" })
    expect(startChoice([model("small.en", false, true)], "small.en")).toEqual({ kind: "prompt" })
  })

  test("a refused download follows the same model's running download and reports any other one", () => {
    const models = [model("tiny.en", false, false), model("small.en", false, true)]
    const status = (state: "downloading" | "verifying" | "failed", modelKey: string) => ({
      download: { state, modelKey },
      models,
    })
    expect(afterRefusedDownload(status("downloading", "small.en"), "small.en")).toBe("follow")
    expect(afterRefusedDownload(status("verifying", "small.en"), "small.en")).toBe("follow")
    expect(afterRefusedDownload(status("downloading", "tiny.en"), "small.en")).toBe("other")
    expect(
      afterRefusedDownload(
        {
          download: { state: "complete", modelKey: "small.en" },
          models: [model("small.en", true, true)],
        },
        "small.en",
      ),
    ).toBe("installed")
  })
})
