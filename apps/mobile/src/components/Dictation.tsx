// Dictation for a text box: the mic button and the status line above the box.
// While the user speaks, the microphone's 16 kHz PCM goes to the server in
// 250 ms chunks (dictation.stream.append), so at "stop" only the last chunk
// is left to send before the server's whisper.cpp transcribes it
// (dictation.stream.finish). The state machine is logic/dictation.ts.

import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioStream,
} from "expo-audio"
import Mic from "lucide-react-native/icons/mic"
import Square from "lucide-react-native/icons/square"
import { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native"
import { type Client, useConnection } from "../connection"
import {
  type DictationEvent,
  type DictationState,
  dictationAvailability,
  dictationStep,
} from "../logic/dictation"
import { bytesToBase64, PcmChunker } from "../logic/pcm"
import { colors } from "../theme"
import { useServerQuery } from "../useServerQuery"

const SAMPLE_RATE = 16_000
/** 250 ms of 16 kHz mono 16-bit PCM. */
const CHUNK_BYTES = 8000
const PERMISSION_REASON =
  "PI Lab uses the microphone to dictate replies to your agents. The audio goes only to your PI Lab computer, which turns it into text."
const NO_MODEL =
  "No dictation model is ready on the computer. Download one in PI Lab on the computer (Settings, Dictation)."

/** One recording on its way to the server. */
interface Recording {
  attempt: number
  client: Client
  streamId: string
  chunker: PcmChunker
  /** The appends, in order; each waits for the one before. */
  queue: Promise<void>
  error: string | null
}

export interface Dictation {
  state: DictationState
  /** False when the mic should not show (old server, no engine, status not read). */
  visible: boolean
  notice: string | null
  press: () => void
  cancel: () => void
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** Ask for the microphone; the reason is shown before the first system prompt. */
async function microphoneAllowed(): Promise<boolean> {
  const current = await getRecordingPermissionsAsync()
  if (current.granted) return true
  if (!current.canAskAgain) return false
  if (current.status === "undetermined") {
    const go = await new Promise<boolean>((resolve) =>
      Alert.alert("Microphone", PERMISSION_REASON, [
        { text: "Not now", style: "cancel", onPress: () => resolve(false) },
        { text: "Continue", onPress: () => resolve(true) },
      ]),
    )
    if (!go) return false
  }
  return (await requestRecordingPermissionsAsync()).granted
}

/** Dictation state for one text box; `onText` gets the transcribed text to add to the draft. */
export function useDictation(onText: (text: string) => void): Dictation {
  const { connection, capabilities } = useConnection()
  const status = useServerQuery("dictation-status", (client) => client.dictation.status.query())
  const availability = dictationAvailability(capabilities, status.data)
  const [state, setState] = useState<DictationState>({ kind: "idle", attempt: 0 })
  const [notice, setNotice] = useState<string | null>(null)
  const stateRef = useRef(state)
  const onTextRef = useRef(onText)
  onTextRef.current = onText
  const recording = useRef<Recording | null>(null)

  const dispatch = useCallback((event: DictationEvent): DictationState => {
    const { state: next, insert } = dictationStep(stateRef.current, event)
    stateRef.current = next
    setState(next)
    if (insert !== null) onTextRef.current(insert)
    return next
  }, [])

  const { stream } = useAudioStream({
    sampleRate: SAMPLE_RATE,
    channels: 1,
    encoding: "int16",
    onBuffer: (buffer) => {
      const current = recording.current
      if (!current || current.error) return
      if (buffer.sampleRate !== SAMPLE_RATE || buffer.channels !== 1) {
        fail(
          current,
          `The microphone records at ${buffer.sampleRate} Hz; dictation needs 16 kHz mono`,
        )
        return
      }
      for (const chunk of current.chunker.push(new Uint8Array(buffer.data))) {
        current.queue = current.queue
          .then(() =>
            current.error
              ? undefined
              : current.client.dictation.stream.append.mutate({
                  streamId: current.streamId,
                  seq: chunk.seq,
                  pcmBase64: bytesToBase64(chunk.bytes),
                }),
          )
          .catch((reason: unknown) => fail(current, `Dictation stopped: ${message(reason)}`))
      }
    },
  })

  const stopMicrophone = useCallback(() => {
    if (stream.isStreaming) stream.stop()
  }, [stream])

  /** End a recording with an error: the microphone stops and the server drops the audio. */
  const fail = (current: Recording, text: string) => {
    if (current.error) return
    current.error = text
    if (recording.current === current) {
      recording.current = null
      stopMicrophone()
    }
    void current.client.dictation.stream.cancel
      .mutate({ streamId: current.streamId })
      .catch(() => undefined)
    dispatch({ type: "failed", attempt: current.attempt, message: text })
  }

  const begin = async (attempt: number, client: Client) => {
    if (!(await microphoneAllowed())) {
      dispatch({
        type: "failed",
        attempt,
        message:
          "Microphone access is off for PI Lab. Allow it in the phone's settings to dictate.",
      })
      return
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
    const { streamId } = await client.dictation.stream.start.mutate()
    const current: Recording = {
      attempt,
      client,
      streamId,
      chunker: new PcmChunker(CHUNK_BYTES),
      queue: Promise.resolve(),
      error: null,
    }
    // Cancelled while starting.
    if (stateRef.current.kind !== "starting" || stateRef.current.attempt !== attempt) {
      await client.dictation.stream.cancel.mutate({ streamId })
      return
    }
    recording.current = current
    await stream.start()
    dispatch({ type: "started", attempt })
  }

  const finish = async (current: Recording) => {
    recording.current = null
    stopMicrophone()
    await current.queue
    if (current.error) return
    const last = current.chunker.finish()
    const result = await current.client.dictation.stream.finish.mutate({
      streamId: current.streamId,
      seq: last.seq,
      pcmBase64: bytesToBase64(last.bytes),
    })
    dispatch({ type: "transcribed", attempt: current.attempt, text: result.text })
  }

  const press = () => {
    setNotice(null)
    if (availability === "no-model") {
      // Read again: a model may have been downloaded since.
      status.reload()
      setNotice(NO_MODEL)
      return
    }
    if (!connection) {
      setNotice("Not connected to the computer.")
      return
    }
    const before = stateRef.current
    const next = dispatch({ type: "press" })
    if (next === before) return
    if (next.kind === "starting") {
      void begin(next.attempt, connection.client).catch((reason: unknown) => {
        const current = recording.current
        if (current?.attempt === next.attempt) fail(current, message(reason))
        else dispatch({ type: "failed", attempt: next.attempt, message: message(reason) })
      })
    }
    if (next.kind === "transcribing") {
      const current = recording.current
      if (!current) return
      void finish(current).catch((reason: unknown) =>
        dispatch({ type: "failed", attempt: current.attempt, message: message(reason) }),
      )
    }
  }

  const cancel = useCallback(() => {
    const current = recording.current
    recording.current = null
    stopMicrophone()
    if (current) {
      current.error = "cancelled"
      void current.client.dictation.stream.cancel
        .mutate({ streamId: current.streamId })
        .catch(() => undefined)
    }
    setNotice(null)
    dispatch({ type: "cancel" })
  }, [dispatch, stopMicrophone])

  // Leaving the screen stops a recording.
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel
  useEffect(() => () => cancelRef.current(), [])

  return { state, visible: availability !== "hidden", notice, press, cancel }
}

/** The round mic button: `mic`, a red stop square while recording, a spinner while transcribing. */
export function MicButton({ dictation, disabled }: { dictation: Dictation; disabled: boolean }) {
  if (!dictation.visible) return null
  const { kind } = dictation.state
  const busy = kind === "starting" || kind === "transcribing"
  return (
    <Pressable
      style={[
        styles.mic,
        kind === "recording" && styles.micRecording,
        disabled && { opacity: 0.5 },
      ]}
      onPress={dictation.press}
      disabled={disabled || busy}
      accessibilityLabel={kind === "recording" ? "Stop dictation" : "Dictate"}
      testID="dictate"
    >
      {busy ? (
        <ActivityIndicator color={colors.text} />
      ) : kind === "recording" ? (
        <Square size={16} color="#fff" fill="#fff" strokeWidth={2} />
      ) : (
        <Mic size={20} color={colors.text} strokeWidth={2} />
      )}
    </Pressable>
  )
}

/** The line above the box: recording time, "Transcribing", or the error, each with Cancel. */
export function DictationBar({ dictation }: { dictation: Dictation }) {
  const { state, notice } = dictation
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (state.kind !== "recording") return
    setSeconds(0)
    const started = Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 500)
    return () => clearInterval(timer)
  }, [state.kind])
  const label =
    state.kind === "starting"
      ? "Starting the microphone"
      : state.kind === "recording"
        ? `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}. Tap the square to stop.`
        : state.kind === "transcribing"
          ? "Transcribing on the computer"
          : state.kind === "error"
            ? state.message
            : notice
  if (label === null) return null
  return (
    <View style={styles.bar} testID="dictation-bar">
      {state.kind === "recording" ? <View style={styles.dot} /> : null}
      <Text style={[styles.barText, state.kind === "error" && { color: colors.danger }]}>
        {label}
      </Text>
      <Pressable onPress={dictation.cancel} hitSlop={8} testID="dictation-cancel">
        <Text style={styles.cancel}>
          {state.kind === "error" || state.kind === "idle" ? "Dismiss" : "Cancel"}
        </Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  mic: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  micRecording: { backgroundColor: colors.danger },
  bar: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.danger },
  barText: { flex: 1, color: colors.muted, fontSize: 13, lineHeight: 18 },
  cancel: { color: colors.accent, fontSize: 14, fontWeight: "600" },
})
