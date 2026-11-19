import { createHash, randomUUID } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import { mkdir, open, readdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  type DictationHistoryEntry,
  type DictationOutputAction,
  type DictationWaveformStyle,
  dictationHistory,
  dictationSettings,
  type PiLabDatabase,
} from "@pi-lab/local-db"
import { desc, eq, sql } from "drizzle-orm"
import { type DictationModel, sizeLabel } from "./catalog"
import { pcm16kToWav } from "./decode"
import {
  type DictationEngine,
  EngineHttpError,
  type EngineState,
  killLeftoverWhisperServer,
} from "./engine"

export type MicrophoneStatus = "granted" | "denied" | "not-determined" | "restricted"

/** macOS microphone permission, injected so tests never touch the OS. */
export interface MicrophonePort {
  status: () => MicrophoneStatus
  request: () => Promise<boolean>
  openSettings: () => Promise<void>
}

export type DownloadState =
  | "idle"
  | "downloading"
  | "verifying"
  | "complete"
  | "failed"
  | "cancelled"

export interface DownloadStatus {
  state: DownloadState
  modelKey: string | null
  receivedBytes: number
  totalBytes: number
  error: string | null
}

export interface DictationStatus {
  engine: { bundled: boolean; state: EngineState; error: string | null }
  models: Array<{
    key: string
    name: string
    sizeBytes: number
    sizeLabel: string
    multilingual: boolean
    recommended: boolean
    installed: boolean
  }>
  selectedModel: string | null
  download: DownloadStatus
  outputAction: DictationOutputAction
  waveformStyle: DictationWaveformStyle
  microphone: MicrophoneStatus
}

/** Recording formats a client may send: WAV goes to the engine as is, the others are decoded first. */
export type DictationAudioFormat = "wav" | "m4a" | "ogg"

/**
 * Turn a compressed recording into a 16 kHz mono 16-bit WAV. A recording
 * longer than `maxSeconds` is refused without decoding it.
 */
export type AudioDecoder = (
  audio: Buffer,
  format: Exclude<DictationAudioFormat, "wav">,
  maxSeconds: number,
) => Promise<Buffer>

/** A transcription with the server's time spent on it, so a client can measure the rest. */
export interface TimedTranscription {
  text: string
  modelKey: string
  timings: { decodeMs: number; transcribeMs: number }
}

/** PCM a client is sending while the user speaks (see {@link DictationService.startStream}). */
interface AudioStream {
  chunks: Buffer[]
  bytes: number
  nextSeq: number
  timer: NodeJS.Timeout
  /** `Date.now()` at start. */
  startedAt: number
}

export interface DictationServiceOptions {
  db: PiLabDatabase
  catalog: readonly DictationModel[]
  /** Writable directory that holds the downloaded model files. */
  modelsDir: string
  /** Null when this build has no bundled engine. */
  engine: DictationEngine | null
  fetch: typeof fetch
  microphone: MicrophonePort
  /** Stop the engine after this long without a prepare or transcribe call. */
  idleMs: number
  /** Where the engine records its server's PID; read on start to stop a leftover server. */
  enginePidFile: string
  /** Fail a download that receives no data for this long. */
  downloadStallMs: number
  /** Decodes m4a and Ogg recordings; null when this machine has no decoder. */
  decodeAudio: AudioDecoder | null
}

/** The one row of `dictation_settings`, with defaults for a fresh database. */
interface DictationSettings {
  selectedModel: string | null
  outputAction: DictationOutputAction
  waveformStyle: DictationWaveformStyle
}

const HISTORY_LIMIT = 100
/** The largest WAV the engine is given, and the largest recording a client may send. */
export const MAX_WAV_BYTES = 64 * 1024 * 1024
/** The longest streamed or compressed recording the server takes: 10 minutes. */
const MAX_RECORDING_SECONDS = 600
/** 16 kHz mono 16-bit PCM. */
const PCM_BYTES_PER_SECOND = 32_000
/** 10 minutes of PCM: 19,200,000 bytes (about 18.3 MiB). */
const MAX_STREAM_BYTES = MAX_RECORDING_SECONDS * PCM_BYTES_PER_SECOND
/** Open streams at once: speech is one stream at a time per device, so a few devices fit. */
const MAX_OPEN_STREAMS = 4
const TOO_LONG = "The recording is longer than 10 minutes, the most dictation takes"
const SETTINGS_ID = 1
/** A stream with no new chunk for this long is dropped (the client went away). */
const STREAM_IDLE_MS = 60_000
const STREAM_GONE = "This recording is no longer on the server"

/**
 * Model downloads, engine lifecycle, settings and history for local dictation.
 * One instance lives for the whole app; the tRPC router only forwards to it.
 */
export class DictationService {
  private download: DownloadStatus = {
    state: "idle",
    modelKey: null,
    receivedBytes: 0,
    totalBytes: 0,
    error: null,
  }
  private downloadAbort: AbortController | null = null
  private streams = new Map<string, AudioStream>()
  private idleTimer: NodeJS.Timeout | null = null
  /** The startup cleanup; the engine waits for it so it never starts before the old one is killed. */
  private cleanup: Promise<void> = Promise.resolve()

  constructor(private readonly options: DictationServiceOptions) {}

  /**
   * Clean up after an earlier run that crashed or was killed: stop its whisper-server and
   * delete its partial downloads. Call once at app start, without waiting for it: prepare and
   * transcribe wait for it before they start the engine.
   */
  start(): Promise<void> {
    this.cleanup = this.removeLeftovers()
    return this.cleanup
  }

  private async removeLeftovers(): Promise<void> {
    await killLeftoverWhisperServer(this.options.enginePidFile)
    if (this.downloadAbort || !existsSync(this.options.modelsDir)) return
    const leftovers = (await readdir(this.options.modelsDir)).filter(
      (name) => name.startsWith(".ggml-") && name.endsWith(".partial"),
    )
    // A download may have started while the directory was read.
    if (this.downloadAbort) return
    for (const name of leftovers) await rm(join(this.options.modelsDir, name), { force: true })
  }

  status(): DictationStatus {
    const settings = this.settings()
    const engine = this.options.engine
    return {
      engine: engine
        ? { bundled: true, ...engine.status() }
        : { bundled: false, state: "stopped", error: null },
      models: this.options.catalog.map((model) => ({
        key: model.key,
        name: model.name,
        sizeBytes: model.sizeBytes,
        sizeLabel: sizeLabel(model.sizeBytes),
        multilingual: model.multilingual,
        recommended: model.recommended,
        installed: this.installed(model),
      })),
      selectedModel: settings.selectedModel,
      download: { ...this.download },
      outputAction: settings.outputAction,
      waveformStyle: settings.waveformStyle,
      microphone: this.options.microphone.status(),
    }
  }

  /** Start a background download; false when one is already running or the model is installed. */
  downloadModel(key: string): { started: boolean } {
    const model = this.model(key)
    if (this.downloadAbort || this.installed(model)) return { started: false }
    const abort = new AbortController()
    this.downloadAbort = abort
    this.download = {
      state: "downloading",
      modelKey: key,
      receivedBytes: 0,
      totalBytes: model.sizeBytes,
      error: null,
    }
    const staging = join(this.options.modelsDir, `.${fileName(model)}.partial`)
    void this.runDownload(model, staging, abort.signal)
      .then(() => {
        this.download = { ...this.download, state: "complete" }
        if (this.settings().selectedModel === null) this.writeSettings({ selectedModel: key })
      })
      .catch(async (error: unknown) => {
        await rm(staging, { force: true })
        this.download = abort.signal.aborted
          ? { ...this.download, state: "cancelled", error: null }
          : { ...this.download, state: "failed", error: errorMessage(error) }
      })
      .finally(() => {
        this.downloadAbort = null
      })
    return { started: true }
  }

  cancelDownload(): void {
    this.downloadAbort?.abort()
  }

  async deleteModel(key: string): Promise<void> {
    const model = this.model(key)
    if (this.download.modelKey === key && this.downloadAbort)
      throw new Error(`${model.name} is downloading; cancel the download first`)
    await rm(this.modelPath(model), { force: true })
    if (this.settings().selectedModel === key) {
      this.options.engine?.stop()
      this.writeSettings({ selectedModel: this.fallbackModel()?.key ?? null })
    }
  }

  /** The installed model to use when the selected one is deleted: recommended, else smallest. */
  private fallbackModel(): DictationModel | undefined {
    const installed = this.options.catalog.filter((entry) => this.installed(entry))
    return (
      installed.find((entry) => entry.recommended) ??
      installed.toSorted((a, b) => a.sizeBytes - b.sizeBytes)[0]
    )
  }

  /** Select an installed model; a running engine restarts with it. */
  selectModel(key: string): void {
    const model = this.model(key)
    if (!this.installed(model)) throw new Error(`${model.name} is not installed`)
    const previous = this.settings().selectedModel
    this.writeSettings({ selectedModel: key })
    const engine = this.options.engine
    if (previous !== key && engine && engine.status().state !== "stopped") {
      // A load failure is kept in the engine status, which the UI reads.
      void this.prepare().catch(() => undefined)
    }
  }

  setOutputAction(action: DictationOutputAction): void {
    this.writeSettings({ outputAction: action })
  }

  setWaveformStyle(style: DictationWaveformStyle): void {
    this.writeSettings({ waveformStyle: style })
  }

  requestMicrophone(): Promise<boolean> {
    return this.options.microphone.request()
  }

  openMicrophoneSettings(): Promise<void> {
    return this.options.microphone.openSettings()
  }

  /** Start or reuse the engine with the selected model; a load error is returned with the state. */
  async prepare(): Promise<{ state: EngineState; error: string | null }> {
    const { engine, model } = this.requireReady()
    this.touch()
    await this.cleanup
    await engine.prepare(this.modelPath(model)).catch(() => undefined)
    const { state, error } = engine.status()
    return { state, error }
  }

  /**
   * Transcribe a 16 kHz mono 16-bit WAV with the selected model. Nothing is saved: the
   * renderer saves the text with {@link addHistory} once it uses it, so a cancelled
   * transcription leaves no history.
   */
  async transcribe(wavBase64: string): Promise<{ text: string; modelKey: string }> {
    const { text, modelKey } = await this.transcribeWav(Buffer.from(wavBase64, "base64"))
    return { text, modelKey }
  }

  /** Transcribe a recording in any {@link DictationAudioFormat}; compressed ones are decoded first. */
  async transcribeAudio(audio: Buffer, format: DictationAudioFormat): Promise<TimedTranscription> {
    if (audio.length === 0) throw new Error("The recording is empty")
    if (audio.length > MAX_WAV_BYTES)
      throw new Error("The recording is larger than 64 MiB, the most the server takes")
    if (format === "wav") return this.transcribeWav(audio)
    const decode = this.options.decodeAudio
    if (!decode) throw new Error(`This server cannot decode ${format} recordings; send a WAV`)
    this.requireReady()
    const started = performance.now()
    const wav = await decode(audio, format, MAX_RECORDING_SECONDS)
    const decodeMs = Math.round(performance.now() - started)
    const result = await this.transcribeWav(wav)
    return { ...result, timings: { ...result.timings, decodeMs } }
  }

  /**
   * Start receiving 16 kHz mono 16-bit PCM while the user speaks, so the audio is on the
   * server when they stop. Also starts loading the model. Chunks come with
   * {@link appendStream}; {@link finishStream} transcribes them.
   */
  startStream(): { streamId: string } {
    this.requireReady()
    if (this.streams.size >= MAX_OPEN_STREAMS)
      throw new Error(
        `${MAX_OPEN_STREAMS} recordings are already open on the server; finish or cancel one first`,
      )
    // A load failure is kept in the engine status and raised again by finish.
    void this.prepare().catch(() => undefined)
    const streamId = randomUUID()
    this.streams.set(streamId, {
      chunks: [],
      bytes: 0,
      nextSeq: 0,
      timer: this.streamTimer(streamId),
      startedAt: Date.now(),
    })
    return { streamId }
  }

  /** Add chunk `seq` (0, 1, 2, ...); a chunk out of order fails and drops the stream. */
  appendStream(streamId: string, seq: number, pcm: Buffer): void {
    const stream = this.streams.get(streamId)
    if (!stream) throw new Error(STREAM_GONE)
    if (seq !== stream.nextSeq) {
      this.cancelStream(streamId)
      throw new Error(
        `Part of the recording was lost (expected part ${stream.nextSeq}, got ${seq})`,
      )
    }
    // The idle timer restarts with each piece; the start time bounds a stream sent slowly.
    const lifetimeMs = MAX_RECORDING_SECONDS * 1000 + STREAM_IDLE_MS
    if (
      stream.bytes + pcm.length > MAX_STREAM_BYTES ||
      Date.now() - stream.startedAt > lifetimeMs
    ) {
      this.cancelStream(streamId)
      throw new Error(TOO_LONG)
    }
    stream.chunks.push(pcm)
    stream.bytes += pcm.length
    stream.nextSeq += 1
    clearTimeout(stream.timer)
    stream.timer = this.streamTimer(streamId)
  }

  /** Add the last chunk (may be empty) and transcribe the whole stream; the stream is then gone. */
  async finishStream(streamId: string, seq: number, pcm: Buffer): Promise<TimedTranscription> {
    this.appendStream(streamId, seq, pcm)
    const stream = this.streams.get(streamId)
    if (!stream) throw new Error(STREAM_GONE)
    this.cancelStream(streamId)
    return this.transcribeWav(pcm16kToWav(Buffer.concat(stream.chunks)))
  }

  cancelStream(streamId: string): void {
    const stream = this.streams.get(streamId)
    if (stream) clearTimeout(stream.timer)
    this.streams.delete(streamId)
  }

  private streamTimer(streamId: string): NodeJS.Timeout {
    return setTimeout(() => this.cancelStream(streamId), STREAM_IDLE_MS).unref()
  }

  /** Transcribe a WAV; `transcribeMs` includes loading the model when it was not loaded. */
  private async transcribeWav(wav: Buffer): Promise<TimedTranscription> {
    const { engine, model } = this.requireReady()
    if (wav.length === 0) throw new Error("The recording is empty")
    if (wav.length > MAX_WAV_BYTES) throw new Error("The recording is too long to transcribe")
    this.touch()
    await this.cleanup
    const started = performance.now()
    await engine.prepare(this.modelPath(model))
    // whisper-server rejects a recording with no samples with HTTP 400; that is no speech.
    const raw = await engine
      .transcribe(wav, model.multilingual ? "auto" : "en")
      .catch((error: unknown) => {
        if (error instanceof EngineHttpError && error.status === 400) return ""
        throw error
      })
    const transcribeMs = Math.round(performance.now() - started)
    this.touch()
    const text = speechText(raw)
    if (!text) throw new Error("No speech was detected")
    return { text, modelKey: model.key, timings: { decodeMs: 0, transcribeMs } }
  }

  /** Save a transcription to history, keeping the newest {@link HISTORY_LIMIT}. */
  addHistory(text: string, modelKey: string): { id: string } {
    const row = this.options.db
      .insert(dictationHistory)
      .values({ text, modelKey })
      .returning({ id: dictationHistory.id })
      .get()
    this.options.db.run(
      sql`DELETE FROM dictation_history WHERE id NOT IN (SELECT id FROM dictation_history ORDER BY created_at DESC, rowid DESC LIMIT ${HISTORY_LIMIT})`,
    )
    return { id: row.id }
  }

  /** Newest first; `query` matches a case-insensitive substring of the text. */
  listHistory(query: string | null): DictationHistoryEntry[] {
    const select = this.options.db.select().from(dictationHistory)
    const filtered = query
      ? select.where(sql`${dictationHistory.text} LIKE ${`%${escapeLike(query)}%`} ESCAPE '\\'`)
      : select
    return filtered.orderBy(desc(dictationHistory.createdAt), desc(sql`rowid`)).all()
  }

  deleteHistory(id: string): void {
    this.options.db.delete(dictationHistory).where(eq(dictationHistory.id, id)).run()
  }

  clearHistory(): void {
    this.options.db.delete(dictationHistory).run()
  }

  /** Stop the engine and any download; called on app quit. */
  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    for (const streamId of [...this.streams.keys()]) this.cancelStream(streamId)
    this.downloadAbort?.abort()
    this.options.engine?.stop()
  }

  private requireReady(): { engine: DictationEngine; model: DictationModel } {
    const engine = this.options.engine
    if (!engine) throw new Error("The dictation engine is not part of this build")
    const key = this.settings().selectedModel
    const model = key ? this.options.catalog.find((entry) => entry.key === key) : undefined
    if (!model || !this.installed(model))
      throw new Error("Download and select a dictation model first")
    return { engine, model }
  }

  /** Restart the idle countdown that stops the engine. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.options.engine?.stop()
    }, this.options.idleMs)
    this.idleTimer.unref()
  }

  private async runDownload(
    model: DictationModel,
    staging: string,
    signal: AbortSignal,
  ): Promise<void> {
    await mkdir(this.options.modelsDir, { recursive: true })
    // Watchdog: abort when no data arrives for the stall time, waiting for headers included.
    const stallMs = this.options.downloadStallMs
    const stall = new AbortController()
    const stalled = new Error(`Download stalled: no data received for ${stallMs / 1000} s`)
    // Unref'd: a timer left by an early failure only aborts a finished download's signal.
    const arm = (): NodeJS.Timeout => setTimeout(() => stall.abort(stalled), stallMs).unref()
    let stallTimer = arm()
    const bump = (): void => {
      clearTimeout(stallTimer)
      stallTimer = arm()
    }
    const fetchSignal = AbortSignal.any([signal, stall.signal])
    const response = await this.options.fetch(model.url, { signal: fetchSignal }).finally(bump)
    if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}`)
    if (!response.body) throw new Error("Model download returned no data")
    const declared = Number(response.headers.get("content-length"))
    if (declared && declared !== model.sizeBytes)
      throw new Error(
        `Model download has the wrong size: expected ${model.sizeBytes} bytes, server sent ${declared}`,
      )
    const reader = response.body.getReader()
    const stopReading = () => void reader.cancel()
    fetchSignal.addEventListener("abort", stopReading)
    const hash = createHash("sha256")
    const file = await open(staging, "w")
    let received = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bump()
        received += value.length
        if (received > model.sizeBytes)
          throw new Error(`Model download exceeds the expected size of ${model.sizeBytes} bytes`)
        hash.update(value)
        await file.write(value)
        this.download = { ...this.download, receivedBytes: received }
      }
    } finally {
      clearTimeout(stallTimer)
      fetchSignal.removeEventListener("abort", stopReading)
      await file.close()
    }
    if (signal.aborted) throw new Error("Model download was cancelled")
    if (stall.signal.aborted) throw stalled
    this.download = { ...this.download, state: "verifying" }
    if (received !== model.sizeBytes)
      throw new Error(
        `Model download ended early: expected size ${model.sizeBytes} bytes, got ${received}`,
      )
    const digest = hash.digest("hex")
    if (digest !== model.sha256)
      throw new Error(`Model SHA-256 mismatch: expected ${model.sha256}, got ${digest}`)
    await rename(staging, this.modelPath(model))
  }

  private model(key: string): DictationModel {
    const model = this.options.catalog.find((entry) => entry.key === key)
    if (!model) throw new Error(`Unknown dictation model: ${key}`)
    return model
  }

  private modelPath(model: DictationModel): string {
    return join(this.options.modelsDir, fileName(model))
  }

  /** A model is installed when its verified file is present with the pinned size. */
  private installed(model: DictationModel): boolean {
    const path = this.modelPath(model)
    return existsSync(path) && statSync(path).size === model.sizeBytes
  }

  private settings(): DictationSettings {
    const row = this.options.db
      .select()
      .from(dictationSettings)
      .where(eq(dictationSettings.id, SETTINGS_ID))
      .get()
    return {
      selectedModel: row?.selectedModel ?? null,
      outputAction: row?.outputAction ?? "insert",
      waveformStyle: waveformStyleOrDots(row?.waveformStyle),
    }
  }

  private writeSettings(patch: Partial<DictationSettings>): void {
    const next = { ...this.settings(), ...patch, updatedAt: Date.now() }
    this.options.db
      .insert(dictationSettings)
      .values({ id: SETTINGS_ID, ...next })
      .onConflictDoUpdate({ target: dictationSettings.id, set: next })
      .run()
  }
}

/** A line made only of bracketed or parenthesised markers, e.g. "[ Silence ]" or "[MUSIC] (wind)". */
const MARKER_LINE = /^\s*(?:(?:\[[^[\]]*\]|\([^()]*\))\s*)+$/

/**
 * The spoken text of a Whisper result, without its non-speech markers ("[ Silence ]",
 * "[BLANK_AUDIO]", "[MUSIC]", "(silence)"). Rule: whisper-server puts each segment on its own
 * line, and a line that holds nothing but such markers is dropped. Brackets in a line that also
 * has words are kept, since a person can dictate them.
 */
function speechText(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => !MARKER_LINE.test(line))
    .join("\n")
    .trim()
}

/** The stored style if it is still one of the three styles, else "dots" (old rows may hold removed styles). */
function waveformStyleOrDots(stored: string | null | undefined): DictationWaveformStyle {
  return stored === "ascii-art" || stored === "lines" ? stored : "dots"
}

function fileName(model: DictationModel): string {
  return `ggml-${model.key}.bin`
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
