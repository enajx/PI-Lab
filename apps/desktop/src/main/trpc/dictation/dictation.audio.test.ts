import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import type { DictationModel } from "../../dictation/catalog"
import type { DictationEngine, EngineStatus } from "../../dictation/engine"
import type { AudioDecoder } from "../../dictation/service"
import { createHarness, type Harness } from "../testHarness"

// Phone dictation: compressed recordings (decoded on the server) and PCM sent
// in chunks while the user speaks. The engine and the decoder are stubbed here
// (labelled per test); the real whisper-server and afconvert run in
// dictation.engine.test.ts.

let h: Harness | undefined
afterEach(async () => {
  await h?.dispose()
  h = undefined
})

const MODEL_BYTES = Buffer.from("fake whisper model bytes for the audio tests")
const MODEL: DictationModel = {
  key: "test.en",
  name: "Test English",
  url: "https://models.test/ggml-test.en.bin",
  sizeBytes: MODEL_BYTES.length,
  sha256: createHash("sha256").update(MODEL_BYTES).digest("hex"),
  multilingual: false,
  recommended: true,
}

/** Stubbed engine: keeps every WAV it is given and answers a fixed text. */
function recordingEngine(text: string): DictationEngine & { wavs: Buffer[] } {
  let status: EngineStatus = { state: "stopped", error: null }
  const wavs: Buffer[] = []
  return {
    wavs,
    status: () => status,
    prepare: async () => {
      status = { state: "ready", error: null }
    },
    transcribe: async (wav) => {
      wavs.push(wav)
      return text
    },
    stop: () => {
      status = { state: "stopped", error: null }
    },
  }
}

/** A harness with the test model installed and selected. */
async function readyHarness(
  engine: DictationEngine,
  decodeAudio: AudioDecoder | null,
): Promise<Harness> {
  const harness = await createHarness([], {
    git: false,
    daemon: "lazy",
    dictationCatalog: [MODEL],
    dictationEngine: engine,
    dictationDecodeAudio: decodeAudio,
  })
  const modelsDir = join(harness.dataDir, "dictation", "models")
  await mkdir(modelsDir, { recursive: true })
  await writeFile(join(modelsDir, "ggml-test.en.bin"), MODEL_BYTES)
  await harness.caller.dictation.selectModel({ key: MODEL.key })
  return harness
}

/** The 44-byte header of a 16 kHz mono 16-bit WAV followed by `pcm`. */
function wavOf(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16_000, 24)
  header.writeUInt32LE(32_000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Stubbed engine and decoder: an m4a is decoded to WAV first; a WAV goes to the engine as is. */
test("transcribes an m4a through the decoder and a WAV without it, with timings", async () => {
  const engine = recordingEngine(" Refactor the tRPC router. ")
  const decoded = wavOf(Buffer.alloc(320, 1))
  const decoderCalls: Array<{ bytes: string; format: string }> = []
  h = await readyHarness(engine, async (audio, format) => {
    decoderCalls.push({ bytes: audio.toString(), format })
    return decoded
  })

  const fromM4a = await h.caller.dictation.transcribeAudio({
    audioBase64: Buffer.from("m4a bytes").toString("base64"),
    format: "m4a",
  })
  expect(fromM4a).toMatchObject({ text: "Refactor the tRPC router.", modelKey: "test.en" })
  expect(fromM4a.timings.decodeMs).toBeGreaterThanOrEqual(0)
  expect(fromM4a.timings.transcribeMs).toBeGreaterThanOrEqual(0)
  expect(decoderCalls).toEqual([{ bytes: "m4a bytes", format: "m4a" }])
  expect(engine.wavs[0]?.equals(decoded)).toBe(true)

  const wav = wavOf(Buffer.alloc(320, 2))
  const fromWav = await h.caller.dictation.transcribeAudio({
    audioBase64: wav.toString("base64"),
    format: "wav",
  })
  expect(fromWav.timings.decodeMs).toBe(0)
  expect(decoderCalls).toHaveLength(1)
  expect(engine.wavs[1]?.equals(wav)).toBe(true)
})

/** Stubbed engine, no decoder: a compressed recording fails with a clear message. */
test("refuses a compressed recording when the server has no decoder", async () => {
  h = await readyHarness(recordingEngine("text"), null)
  await expect(
    h.caller.dictation.transcribeAudio({ audioBase64: "AAAA", format: "ogg" }),
  ).rejects.toThrow("This server cannot decode ogg recordings; send a WAV")
})

/** Stubbed engine: PCM chunks sent in order become one WAV at finish; the stream is then gone. */
test("joins PCM chunks into one WAV and transcribes it at finish", async () => {
  const engine = recordingEngine("hello from the phone")
  h = await readyHarness(engine, null)
  const caller = h.caller
  const { streamId } = await caller.dictation.stream.start()
  const first = Buffer.alloc(3200, 3)
  const second = Buffer.alloc(1600, 4)
  await caller.dictation.stream.append({ streamId, seq: 0, pcmBase64: first.toString("base64") })
  await caller.dictation.stream.append({ streamId, seq: 1, pcmBase64: second.toString("base64") })
  const result = await caller.dictation.stream.finish({ streamId, seq: 2, pcmBase64: "" })
  expect(result).toMatchObject({ text: "hello from the phone", modelKey: "test.en" })
  expect(engine.wavs[0]?.equals(wavOf(Buffer.concat([first, second])))).toBe(true)
  await expect(caller.dictation.stream.finish({ streamId, seq: 3, pcmBase64: "" })).rejects.toThrow(
    "This recording is no longer on the server",
  )
})

/** Stubbed engine: a missing chunk fails the stream instead of transcribing a gap; cancel drops it. */
test("fails a stream with a missing chunk and drops a cancelled one", async () => {
  h = await readyHarness(recordingEngine("text"), null)
  const caller = h.caller
  const gap = await caller.dictation.stream.start()
  await caller.dictation.stream.append({ streamId: gap.streamId, seq: 0, pcmBase64: "AAAA" })
  await expect(
    caller.dictation.stream.append({ streamId: gap.streamId, seq: 2, pcmBase64: "AAAA" }),
  ).rejects.toThrow("Part of the recording was lost (expected part 1, got 2)")
  await expect(
    caller.dictation.stream.finish({ streamId: gap.streamId, seq: 1, pcmBase64: "" }),
  ).rejects.toThrow("This recording is no longer on the server")

  const cancelled = await caller.dictation.stream.start()
  await caller.dictation.stream.cancel({ streamId: cancelled.streamId })
  await expect(
    caller.dictation.stream.append({ streamId: cancelled.streamId, seq: 0, pcmBase64: "AAAA" }),
  ).rejects.toThrow("This recording is no longer on the server")
})
