import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { DICTATION_MODELS } from "../../dictation/catalog"
import { resolveWhisperServer, WhisperServerEngine } from "../../dictation/engine"
import { createHarness, type Harness } from "../testHarness"

// Real boundary: the bundled whisper-server built by `bun run prepare:whisper`,
// the real tiny.en model from Hugging Face (cached between runs) and a WAV
// recorded with macOS `say`. Nothing is mocked.
const repoRoot = join(import.meta.dirname, "..", "..", "..", "..", "..", "..")
const resourcesDir = join(repoRoot, "apps", "desktop", "resources", "whisper")
const modelsDir = join(repoRoot, ".cache", "whisper-test-models")
const binary = await resolveWhisperServer(resourcesDir)
const skipReason = `skipped: no whisper-server in ${resourcesDir}; run \`bun run prepare:whisper\` in apps/desktop`
const title = binary
  ? "transcribes a real recording with the bundled engine and the tiny.en model"
  : skipReason
const emptyTitle = binary
  ? "reports no speech for a recording with no samples (the engine answers HTTP 400)"
  : skipReason

let h: Harness | undefined
afterEach(async () => {
  await h?.dispose()
  h = undefined
})

test.skipIf(!binary)(
  title,
  async () => {
    const engine = new WhisperServerEngine(
      binary ?? "",
      join(modelsDir, "..", "whisper-server.pid"),
    )
    h = await createHarness([], {
      git: false,
      daemon: "lazy",
      httpFetch: (...args) => fetch(...args),
      dictationCatalog: DICTATION_MODELS,
      dictationModelsDir: modelsDir,
      dictationEngine: engine,
    })
    const caller = h.caller
    const tiny = (await caller.dictation.status()).models.find((model) => model.key === "tiny.en")
    if (!tiny?.installed) {
      expect(await caller.dictation.downloadModel({ key: "tiny.en" })).toEqual({ started: true })
      await vi.waitFor(
        async () => {
          const { download } = await caller.dictation.status()
          if (download.state === "failed") throw new Error(`download failed: ${download.error}`)
          expect(download.state).toBe("complete")
        },
        { timeout: 600_000, interval: 500 },
      )
    } else {
      await caller.dictation.selectModel({ key: "tiny.en" })
    }
    expect((await caller.dictation.status()).selectedModel).toBe("tiny.en")

    expect(await caller.dictation.prepare()).toEqual({ state: "ready", error: null })
    expect((await caller.dictation.status()).engine).toEqual({
      bundled: true,
      state: "ready",
      error: null,
    })
    const wav = readFileSync(
      join(import.meta.dirname, "../../dictation/__fixtures__/hello-world.wav"),
    )
    const result = await caller.dictation.transcribe({ wavBase64: wav.toString("base64") })
    expect(result.text.toLowerCase()).toMatch(/hello,? world/)
    expect(result.modelKey).toBe("tiny.en")
    const saved = await caller.dictation.history.add(result)
    const history = await caller.dictation.history.list({ query: "hello" })
    expect(history[0]).toMatchObject({ id: saved.id, modelKey: "tiny.en" })

    await h.dispose()
    h = undefined
    expect(engine.status().state).toBe("stopped")
  },
  660_000,
)

test.skipIf(!binary)(
  emptyTitle,
  async () => {
    h = await createHarness([], {
      git: false,
      daemon: "lazy",
      httpFetch: (...args) => fetch(...args),
      dictationCatalog: DICTATION_MODELS,
      dictationModelsDir: modelsDir,
      dictationEngine: new WhisperServerEngine(
        binary ?? "",
        join(modelsDir, "..", "whisper-server.pid"),
      ),
    })
    const caller = h.caller
    const tiny = (await caller.dictation.status()).models.find((model) => model.key === "tiny.en")
    if (!tiny?.installed)
      throw new Error(`tiny.en is not cached in ${modelsDir}; run the test above first`)
    await caller.dictation.selectModel({ key: "tiny.en" })
    await expect(
      caller.dictation.transcribe({ wavBase64: silentWav(0).toString("base64") }),
    ).rejects.toThrow(/^No speech was detected$/)
    expect(await caller.dictation.history.list({ query: null })).toHaveLength(0)
  },
  120_000,
)

/** A 16 kHz mono 16-bit WAV of `samples` zero samples. */
function silentWav(samples: number): Buffer {
  const data = Buffer.alloc(samples * 2)
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16_000, 24)
  header.writeUInt32LE(32_000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}
