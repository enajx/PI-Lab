import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import { History } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { QuickFind, type QuickFindItem } from "../QuickFind"
import { rememberSettingsReturnRoute } from "../routes/_shell/-settingsReturnRoute"
import { eventMatchesShortcut } from "../shortcuts/shortcuts"
import { useTRPC, useTRPCClient } from "../trpc/react"
import { DictationPill } from "./DictationPill"
import {
  afterRefusedDownload,
  type DictationEvent,
  type DictationState,
  dictationReducer,
  type ErrorAction,
  type OutputAction,
  startChoice,
} from "./dictationMachine"
import { closeDictationHistory, useDictationHistoryOpen } from "./historyPicker"
import { type Recording, startRecording } from "./recorder"
import { type DictationTarget, focusedDictationTarget, lastFocusedDictationTarget } from "./targets"

const IDLE: DictationState = { phase: "idle" }
const COPIED_MS = 1200
const MICROPHONE_OFF =
  "PI Lab cannot use the microphone. Turn on microphone access in System Settings."

/**
 * App-wide dictation: listens for the dictation shortcut, records from the microphone,
 * sends the audio to the local engine, and puts the text into the pane that was focused
 * when the shortcut was pressed. Also renders the "Dictation history" picker.
 */
export function DictationController() {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { location } = useRouterState()
  const status = useQuery(
    trpc.dictation.status.queryOptions(undefined, {
      refetchInterval: (query) => {
        const download = query.state.data?.download.state
        return download === "downloading" || download === "verifying" ? 250 : false
      },
    }),
  )
  const [state, setState] = useState<DictationState>(IDLE)
  const stateRef = useRef(state)
  const dispatch = useCallback((event: DictationEvent): DictationState => {
    const next = dictationReducer(stateRef.current, event)
    stateRef.current = next
    setState(next)
    return next
  }, [])

  const target = useRef<DictationTarget | null>(null)
  /** The recording being started or running; stop waits for it. */
  const pendingRecording = useRef<Promise<Recording> | null>(null)
  /** The running recording, read by the listening wave for the live level. */
  const recording = useRef<Recording | null>(null)
  /** The recording whose stop is waiting for its last samples; Esc cancels it. */
  const stopping = useRef<Recording | null>(null)
  const prepared = useRef<Promise<string | null> | null>(null)
  const engineReady = useRef(false)
  /** Bumped by cancel, so results of work started before it are dropped. */
  const run = useRef(0)
  const loadingStatus = useRef(false)
  const statusRef = useRef(status.data)
  statusRef.current = status.data
  const locationRef = useRef(location)
  locationRef.current = location

  const fail = useCallback(
    (message: string, action: ErrorAction): void => {
      recording.current?.cancel()
      recording.current = null
      pendingRecording.current = null
      dispatch({ type: "fail", message, action })
    },
    [dispatch],
  )

  /** Open the microphone and start the engine loading the model while the user speaks. */
  const beginListening = useCallback(
    async (current: number): Promise<void> => {
      const data = statusRef.current
      if (data && (data.microphone === "denied" || data.microphone === "restricted")) {
        fail(MICROPHONE_OFF, "open-microphone-settings")
        return
      }
      if (data?.microphone === "not-determined") {
        const { granted } = await client.dictation.requestMicrophone.mutate()
        void queryClient.invalidateQueries({ queryKey: trpc.dictation.status.queryKey() })
        if (run.current !== current) return
        if (!granted) {
          fail(MICROPHONE_OFF, "open-microphone-settings")
          return
        }
      }
      engineReady.current = false
      prepared.current = client.dictation.prepare.mutate().then(
        ({ state: engineState, error }) => {
          if (engineState === "ready") {
            engineReady.current = true
            return null
          }
          return error ?? "The local dictation engine could not load the model."
        },
        (error: unknown) => messageOf(error),
      )
      const pending = startRecording()
      pendingRecording.current = pending
      const started = await pending
      if (run.current !== current) {
        started.cancel()
        return
      }
      recording.current = started
    },
    [client, fail, queryClient, trpc],
  )

  /** Select an installed model (none was selected), then start listening with it. */
  const selectAndListen = useCallback(
    async (key: string, current: number): Promise<void> => {
      await client.dictation.selectModel.mutate({ key })
      statusRef.current = await queryClient.fetchQuery({
        ...trpc.dictation.status.queryOptions(),
        staleTime: 0,
      })
      if (run.current !== current) return
      await beginListening(current)
    },
    [beginListening, client, queryClient, trpc],
  )

  /** Put the text where the output action says, then report it to the state machine. */
  const deliver = useCallback(
    (text: string, outputAction: OutputAction): void => {
      const next = dispatch({ type: "transcribed", text, outputAction })
      if (next.phase === "error" || next.phase === "review") return
      if (outputAction === "insert" || outputAction === "insert-copy") {
        target.current?.insert(text)
        target.current?.focus()
      }
      if (outputAction === "copy" || outputAction === "insert-copy") {
        void navigator.clipboard.writeText(text).then(
          () => window.setTimeout(() => dispatch({ type: "copied-done" }), COPIED_MS),
          (error: unknown) => fail(`Could not copy the text: ${messageOf(error)}`, "none"),
        )
      }
    },
    [dispatch, fail],
  )

  /** Stop recording, wait for the model, transcribe, and deliver the text. */
  const stopAndTranscribe = useCallback(
    async (key: "toggle" | "enter", current: number): Promise<void> => {
      const pending = pendingRecording.current
      pendingRecording.current = null
      recording.current = null
      dispatch(
        key === "toggle"
          ? { type: "toggle", modelInstalled: true, engineReady: engineReady.current }
          : { type: "enter", engineReady: engineReady.current },
      )
      if (!pending) {
        fail("The microphone did not start.", "none")
        return
      }
      const active = await pending
      if (run.current !== current) {
        active.cancel()
        return
      }
      stopping.current = active
      const { wavBase64, speech } = await active.stop().finally(() => {
        stopping.current = null
      })
      if (run.current !== current) return
      // Whisper turns silence into made-up words, so a recording that never reached
      // speech level is not transcribed.
      if (!speech) {
        fail("No speech was detected", "none")
        return
      }
      const prepareError = await prepared.current
      if (run.current !== current) return
      if (prepareError) {
        fail(prepareError, "choose-model")
        return
      }
      dispatch({ type: "engine-ready" })
      const result = await client.dictation.transcribe.mutate({ wavBase64 })
      // Cancelled while transcribing: the text is dropped and not saved to history.
      if (run.current !== current) return
      await client.dictation.history.add.mutate(result)
      void queryClient.invalidateQueries({ queryKey: trpc.dictation.history.list.queryKey() })
      if (run.current !== current) return
      deliver(result.text, statusRef.current?.outputAction ?? "insert")
    },
    [client, deliver, dispatch, fail, queryClient, trpc],
  )

  const cancel = useCallback((): void => {
    run.current += 1
    recording.current?.cancel()
    recording.current = null
    stopping.current?.cancel()
    stopping.current = null
    pendingRecording.current = null
    const wasActive = stateRef.current.phase !== "idle"
    dispatch({ type: "cancel" })
    if (wasActive) target.current?.focus()
  }, [dispatch])

  /** Run one step of the flow; any error it throws becomes the error pill. */
  const step = useCallback(
    (work: (current: number) => Promise<void>): void => {
      const current = run.current
      void work(current).catch((error: unknown) => {
        if (run.current !== current) return
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          fail(MICROPHONE_OFF, "open-microphone-settings")
          return
        }
        fail(messageOf(error), "none")
      })
    },
    [fail],
  )

  const onShortcut = useCallback((): void => {
    const phase = stateRef.current.phase
    if (phase === "listening") {
      step((current) => stopAndTranscribe("toggle", current))
      return
    }
    if (phase !== "idle") {
      // From review, the shortcut drops the text and starts a new dictation.
      const next = dispatch({ type: "toggle", modelInstalled: true, engineReady: true })
      if (next.phase === "idle") target.current?.focus()
      if (next.phase === "listening") {
        target.current?.focus()
        step(beginListening)
      }
      return
    }
    const data = statusRef.current
    if (!data) {
      // The status has not loaded yet (just after launch): load it, then start.
      if (loadingStatus.current) return
      loadingStatus.current = true
      void queryClient.fetchQuery(trpc.dictation.status.queryOptions()).then(
        (loaded) => {
          loadingStatus.current = false
          statusRef.current = loaded
          if (stateRef.current.phase === "idle") onShortcutRef.current()
        },
        (error: unknown) => {
          loadingStatus.current = false
          dispatch({ type: "toggle", modelInstalled: true, engineReady: false })
          fail(`Could not read the dictation status: ${messageOf(error)}`, "none")
        },
      )
      return
    }
    if (!data.engine.bundled) {
      dispatch({ type: "toggle", modelInstalled: true, engineReady: false })
      fail("The dictation engine is not part of this build.", "none")
      return
    }
    const choice = startChoice(data.models, data.selectedModel)
    const next = dispatch({
      type: "toggle",
      modelInstalled: choice.kind !== "prompt",
      engineReady: false,
    })
    if (next.phase !== "listening") return
    if (choice.kind === "select") step((current) => selectAndListen(choice.key, current))
    else step(beginListening)
  }, [beginListening, dispatch, fail, queryClient, selectAndListen, step, stopAndTranscribe, trpc])

  // Capture phase on window, installed before the shell's own listeners (child effects
  // run first), so the keys dictation uses never reach the terminal or the editor.
  const onShortcutRef = useRef(onShortcut)
  onShortcutRef.current = onShortcut
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel
  const onEnterRef = useRef(() => step((current) => stopAndTranscribe("enter", current)))
  onEnterRef.current = () => step((current) => stopAndTranscribe("enter", current))
  useLayoutEffect(() => {
    const consume = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (document.querySelector('[data-shortcut-recording="true"]')) return
      const phase = stateRef.current.phase
      if (eventMatchesShortcut(event, "dictation-toggle")) {
        if (phase === "idle") {
          const focused = focusedDictationTarget()
          if (!focused) return
          target.current = focused
        }
        consume(event)
        if (!event.repeat) onShortcutRef.current()
        return
      }
      const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
      // Enter or Space stops and transcribes; neither reaches the terminal or editor.
      const stopKey = event.key === "Enter" || event.key === " "
      if (phase === "listening" && stopKey && plain && !event.isComposing) {
        consume(event)
        onEnterRef.current()
        return
      }
      // A held stop key repeats after listening ends; the repeats are dropped too.
      if ((phase === "loading" || phase === "transcribing") && stopKey && event.repeat) {
        consume(event)
        return
      }
      if (phase !== "idle" && event.key === "Escape") {
        consume(event)
        cancelRef.current()
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [])

  // A finished first-use download starts listening right away; a failed one shows why.
  const download = status.data?.download
  useEffect(() => {
    if (stateRef.current.phase !== "downloading" || !download) return
    if (download.state === "complete") {
      const next = dispatch({ type: "download-complete" })
      if (next.phase === "listening") {
        target.current?.focus()
        step(beginListening)
      }
    } else if (download.state === "cancelled") {
      dispatch({ type: "download-cancelled" })
      target.current?.focus()
    } else if (download.state === "failed") {
      fail(`The model download failed: ${download.error ?? "unknown error"}`, "choose-model")
    }
  }, [beginListening, dispatch, download, fail, step])

  // Closing the pane under the overlay ends dictation.
  useEffect(() => {
    if (state.phase !== "idle" && !target.current?.element.isConnected) cancel()
  })

  const level = useCallback((): number => recording.current?.level() ?? 0, [])
  const recommended = status.data?.models.find((model) => model.recommended) ?? null

  const openDictationSettings = (): void => {
    cancel()
    rememberSettingsReturnRoute(locationRef.current)
    void navigate({ to: "/settings", search: { section: "dictation" } })
  }

  const startDownload = (): void => {
    if (!recommended) return
    step(async (current) => {
      const { started } = await client.dictation.downloadModel.mutate({ key: recommended.key })
      if (run.current !== current) return
      if (!started) {
        const fresh = await queryClient.fetchQuery({
          ...trpc.dictation.status.queryOptions(),
          staleTime: 0,
        })
        if (run.current !== current) return
        const outcome = afterRefusedDownload(fresh, recommended.key)
        if (outcome === "other") {
          fail("Another model download is already running.", "choose-model")
          return
        }
        if (outcome === "installed") {
          dispatch({ type: "download-started" })
          dispatch({ type: "download-complete" })
          target.current?.focus()
          await selectAndListen(recommended.key, current)
          return
        }
        // "follow": the same model is already downloading (started from Settings).
        dispatch({ type: "download-started" })
        return
      }
      // Wait for the new download's status before following it, so an older "complete" is not read.
      await queryClient.refetchQueries({ queryKey: trpc.dictation.status.queryKey() })
      if (run.current === current) dispatch({ type: "download-started" })
    })
  }

  const insertReviewed = (text: string): void => {
    dispatch({ type: "review-done" })
    target.current?.insert(text)
    target.current?.focus()
  }

  const copyReviewed = (text: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => {
        dispatch({ type: "review-done" })
        target.current?.focus()
      },
      (error: unknown) => fail(`Could not copy the text: ${messageOf(error)}`, "none"),
    )
  }

  const onErrorAction = (action: ErrorAction): void => {
    if (action === "open-microphone-settings") {
      void client.dictation.openMicrophoneSettings.mutate()
      cancel()
    } else if (action === "choose-model") {
      openDictationSettings()
    }
  }

  const anchor = target.current?.element
  const pill =
    state.phase !== "idle" && anchor?.isConnected ? (
      <DictationPill
        state={state}
        anchor={anchor}
        waveformStyle={status.data?.waveformStyle ?? "dots"}
        level={level}
        download={download ?? null}
        promptModel={recommended}
        onDownload={startDownload}
        onChooseModel={openDictationSettings}
        onCancelDownload={() => void client.dictation.cancelDownload.mutate()}
        onInsert={insertReviewed}
        onCopy={copyReviewed}
        onCloseReview={cancel}
        onErrorAction={onErrorAction}
        onOpenSettings={openDictationSettings}
      />
    ) : null

  return (
    <>
      {pill ? createPortal(pill, document.body) : null}
      <DictationHistoryPicker />
    </>
  )
}

/**
 * The command palette's "Dictation history" picker. Choosing an entry inserts it into the
 * terminal or editor that had focus before the palette opened.
 */
function DictationHistoryPicker() {
  const open = useDictationHistoryOpen()
  const trpc = useTRPC()
  const history = useQuery({
    ...trpc.dictation.history.list.queryOptions({ query: null }),
    enabled: open,
  })
  if (!open) return null
  const destination = lastFocusedDictationTarget()
  const entries = history.data ?? []
  const items: QuickFindItem[] = destination
    ? entries.map((entry) => ({
        id: entry.id,
        label: entry.text,
        hint: new Date(entry.createdAt).toLocaleString(),
        icon: History,
      }))
    : []
  const emptyText = history.error
    ? `Could not load dictation history: ${history.error.message}`
    : !destination
      ? "Focus a terminal or editor first, then open Dictation history."
      : history.isPending
        ? "Loading…"
        : entries.length === 0
          ? "No dictations yet"
          : "No matching dictations"
  return (
    <QuickFind
      ariaLabel="Dictation history"
      placeholder="Search dictation history…"
      items={items}
      emptyText={emptyText}
      onSelect={(item) => {
        const entry = entries.find((candidate) => candidate.id === item.id)
        closeDictationHistory()
        if (!entry || !destination) return
        destination.insert(entry.text)
        destination.focus()
      }}
      onClose={() => {
        closeDictationHistory()
        destination?.focus()
      }}
    />
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
