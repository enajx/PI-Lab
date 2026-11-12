import { createHash } from "node:crypto"
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
}

/** The one row of `dictation_settings`, with defaults for a fresh database. */
interface DictationSettings {
  selectedModel: string | null
  outputAction: DictationOutputAction
  waveformStyle: DictationWaveformStyle
}

const HISTORY_LIMIT = 100
const MAX_WAV_BYTES = 64 * 1024 * 1024
const SETTINGS_ID = 1

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
  private idleTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: DictationServiceOptions) {}

  /**
   * Clean up after an earlier run that crashed or was killed: stop its whisper-server and
   * delete its partial downloads. Call once before the engine or a download starts.
   */
  async start(): Promise<void> {
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
    const { engine, model } = this.requireReady()
    const wav = Buffer.from(wavBase64, "base64")
    if (wav.length === 0) throw new Error("The recording is empty")
    if (wav.length > MAX_WAV_BYTES) throw new Error("The recording is too long to transcribe")
    this.touch()
    await engine.prepare(this.modelPath(model))
    // whisper-server rejects a recording with no samples with HTTP 400; that is no speech.
    const raw = await engine
      .transcribe(wav, model.multilingual ? "auto" : "en")
      .catch((error: unknown) => {
        if (error instanceof EngineHttpError && error.status === 400) return ""
        throw error
      })
    this.touch()
    const text = raw.replaceAll("[BLANK_AUDIO]", "").trim()
    if (!text) throw new Error("No speech was detected")
    return { text, modelKey: model.key }
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
