import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import type { DictationModel } from "../../dictation/catalog"
import type { DictationEngine, EngineStatus } from "../../dictation/engine"
import { createHarness, type Harness } from "../testHarness"

// Phone dictation: PCM sent in chunks while the user speaks. The engine is
// stubbed here (labelled per test); the real whisper-server runs in
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
async function readyHarness(engine: DictationEngine): Promise<Harness> {
  const harness = await createHarness([], {
    git: false,
    daemon: "lazy",
    dictationCatalog: [MODEL],
    dictationEngine: engine,
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

/** Stubbed engine: PCM chunks sent in order become one WAV at finish; the stream is then gone. */
test("joins PCM chunks into one WAV and transcribes it at finish", async () => {
  const engine = recordingEngine("hello from the phone")
  h = await readyHarness(engine)
  const caller = h.caller
  const { streamId } = await caller.dictation.stream.start()
  const first = Buffer.alloc(3200, 3)
  const second = Buffer.alloc(1600, 4)
  await caller.dictation.stream.append({ streamId, seq: 0, pcmBase64: first.toString("base64") })
  await caller.dictation.stream.append({ streamId, seq: 1, pcmBase64: second.toString("base64") })
  const result = await caller.dictation.stream.finish({ streamId, seq: 2, pcmBase64: "" })
  expect(result).toEqual({ text: "hello from the phone", modelKey: "test.en" })
  expect(engine.wavs[0]?.equals(wavOf(Buffer.concat([first, second])))).toBe(true)
  await expect(caller.dictation.stream.finish({ streamId, seq: 3, pcmBase64: "" })).rejects.toThrow(
    "This recording is no longer on the server",
  )
})

/** Stubbed engine: a missing chunk fails the stream instead of transcribing a gap; cancel drops it. */
test("fails a stream with a missing chunk and drops a cancelled one", async () => {
  h = await readyHarness(recordingEngine("text"))
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

/** Stubbed engine: at most four streams are open at once; cancelling one frees its place. */
test("refuses a fifth open stream with a clear error", async () => {
  h = await readyHarness(recordingEngine("text"))
  const caller = h.caller
  const open = []
  for (let index = 0; index < 4; index += 1) open.push(await caller.dictation.stream.start())
  await expect(caller.dictation.stream.start()).rejects.toThrow(
    "4 recordings are already open on the server; finish or cancel one first",
  )
  await caller.dictation.stream.cancel({ streamId: open[0]?.streamId ?? "" })
  await expect(caller.dictation.stream.start()).resolves.toMatchObject({
    streamId: expect.any(String),
  })
})

/** Stubbed engine: a stream holds at most 10 minutes of 16 kHz 16-bit mono PCM (19,200,000 bytes). */
test("refuses a stream longer than 10 minutes and drops it", async () => {
  h = await readyHarness(recordingEngine("text"))
  const caller = h.caller
  const { streamId } = await caller.dictation.stream.start()
  const minute = Buffer.alloc(16_000 * 2 * 60, 5).toString("base64")
  for (let seq = 0; seq < 10; seq += 1)
    await caller.dictation.stream.append({ streamId, seq, pcmBase64: minute })
  await expect(
    caller.dictation.stream.append({ streamId, seq: 10, pcmBase64: "AAAA" }),
  ).rejects.toThrow("The recording is longer than 10 minutes, the most dictation takes")
  await expect(
    caller.dictation.stream.finish({ streamId, seq: 11, pcmBase64: "" }),
  ).rejects.toThrow("This recording is no longer on the server")
})

/** Stubbed engine: pieces sent slowly cannot keep a stream open past 10 minutes and the idle time. */
test("refuses a piece for a stream started 12 minutes ago", async () => {
  h = await readyHarness(recordingEngine("text"))
  const caller = h.caller
  const started = Date.now()
  const { streamId } = await caller.dictation.stream.start()
  await caller.dictation.stream.append({ streamId, seq: 0, pcmBase64: "AAAA" })
  vi.spyOn(Date, "now").mockReturnValue(started + 12 * 60_000)
  await expect(
    caller.dictation.stream.append({ streamId, seq: 1, pcmBase64: "AAAA" }),
  ).rejects.toThrow("The recording is longer than 10 minutes, the most dictation takes")
  vi.restoreAllMocks()
})
