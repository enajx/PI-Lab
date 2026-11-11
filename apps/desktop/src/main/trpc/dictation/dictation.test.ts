import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import type { DictationModel } from "../../dictation/catalog"
import { type DictationEngine, EngineHttpError, type EngineStatus } from "../../dictation/engine"
import { createHarness, type Harness } from "../testHarness"

let h: Harness | undefined
afterEach(async () => {
  await h?.dispose()
  h = undefined
})

const MODEL_BYTES = Buffer.from("fake whisper model bytes for the download tests")

function testModel(key: string, bytes: Buffer): DictationModel {
  return {
    key,
    name: `Test ${key}`,
    url: `https://models.test/ggml-${key}.bin`,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    multilingual: !key.endsWith(".en"),
    recommended: key === "test.en",
  }
}

/** Mocked HTTP: a response whose body chunks are pushed by the test. */
function controlledResponse(): {
  response: Response
  push: (chunk: Buffer) => void
  end: () => void
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
  })
  return {
    response: new Response(body, { status: 200 }),
    push: (chunk) => controller?.enqueue(new Uint8Array(chunk)),
    end: () => controller?.close(),
  }
}

/** Mocked engine: records calls and returns a fixed transcription. */
function fakeEngine(text: string): DictationEngine & { prepared: string[] } {
  let status: EngineStatus = { state: "stopped", error: null }
  const prepared: string[] = []
  return {
    prepared,
    status: () => status,
    prepare: async (modelPath) => {
      prepared.push(modelPath)
      status = { state: "ready", error: null }
    },
    transcribe: async () => text,
    stop: () => {
      status = { state: "stopped", error: null }
    },
  }
}

async function dictationHarness(
  catalog: readonly DictationModel[],
  httpFetch: typeof fetch,
  engine: DictationEngine | null,
): Promise<Harness> {
  return createHarness([], {
    git: false,
    daemon: "lazy",
    httpFetch,
    dictationCatalog: catalog,
    dictationEngine: engine,
  })
}

/** Download `key` through the router and wait until it is installed. */
async function install(caller: Harness["caller"], key: string): Promise<void> {
  await caller.dictation.downloadModel({ key })
  await vi.waitFor(async () =>
    expect((await caller.dictation.status()).download).toMatchObject({
      state: "complete",
      modelKey: key,
    }),
  )
}

/** Mocked HTTP: progress is streamed, the file is verified, installed and auto-selected. */
test("downloads a model with byte progress, verifies it and selects it", async () => {
  const model = testModel("test.en", MODEL_BYTES)
  const served = controlledResponse()
  const fetchMock = vi.fn(async () => served.response)
  h = await dictationHarness([model], fetchMock as unknown as typeof fetch, null)
  const caller = h.caller

  const before = await caller.dictation.status()
  expect(before.models[0]).toMatchObject({ key: "test.en", installed: false, recommended: true })
  expect(before.selectedModel).toBeNull()
  expect(before.engine.bundled).toBe(false)

  expect(await caller.dictation.downloadModel({ key: "test.en" })).toEqual({ started: true })
  expect(await caller.dictation.downloadModel({ key: "test.en" })).toEqual({ started: false })
  served.push(MODEL_BYTES.subarray(0, 10))
  await vi.waitFor(async () =>
    expect((await caller.dictation.status()).download).toMatchObject({
      state: "downloading",
      modelKey: "test.en",
      receivedBytes: 10,
      totalBytes: MODEL_BYTES.length,
    }),
  )
  served.push(MODEL_BYTES.subarray(10))
  served.end()
  await vi.waitFor(async () =>
    expect((await caller.dictation.status()).download.state).toBe("complete"),
  )
  const after = await caller.dictation.status()
  expect(after.models[0]?.installed).toBe(true)
  expect(after.selectedModel).toBe("test.en")
  expect(fetchMock).toHaveBeenCalledWith(model.url, expect.anything())
})

/** Mocked HTTP: a file with the wrong digest fails, is not installed and leaves no staging file. */
test("rejects a download whose SHA-256 does not match", async () => {
  const model = testModel("test.en", MODEL_BYTES)
  const wrong = Buffer.alloc(MODEL_BYTES.length, 7)
  h = await dictationHarness([model], (async () => new Response(wrong)) as typeof fetch, null)
  const caller = h.caller
  await caller.dictation.downloadModel({ key: "test.en" })
  await vi.waitFor(async () =>
    expect((await caller.dictation.status()).download.state).toBe("failed"),
  )
  const status = await caller.dictation.status()
  expect(status.download.error).toMatch(/SHA-256/)
  expect(status.models[0]?.installed).toBe(false)
  expect(status.selectedModel).toBeNull()
  const modelsDir = join(h.dataDir, "dictation", "models")
  expect(existsSync(modelsDir) ? readdirSync(modelsDir) : []).toEqual([])
})

/** Mocked HTTP: a response larger than the pinned size is stopped and reported. */
test("stops a download that exceeds the pinned size", async () => {
  const model = testModel("test.en", MODEL_BYTES)
  const larger = Buffer.concat([MODEL_BYTES, Buffer.from("extra")])
  h = await dictationHarness([model], (async () => new Response(larger)) as typeof fetch, null)
  const caller = h.caller
  await caller.dictation.downloadModel({ key: "test.en" })
  await vi.waitFor(async () =>
    expect((await caller.dictation.status()).download.state).toBe("failed"),
  )
  expect((await caller.dictation.status()).download.error).toMatch(/size/)
})

/** Mocked HTTP: an HTTP error surfaces in status. */
test("reports an HTTP failure in status", async () => {
  const model = testModel("test.en", MODEL_BYTES)
  h = await dictationHarness(
    [model],
    (async () => new Response("missing", { status: 404 })) as typeof fetch,
    null,
  )
  const caller = h.caller
  await caller.dictation.downloadModel({ key: "test.en" })
  await vi.waitFor(async () =>
    expect((await caller.dictation.status()).download).toMatchObject({
      state: "failed",
      error: expect.stringMatching(/404/),
    }),
  )
})

/** Mocked HTTP: cancel stops a running download and removes the partial file. */
test("cancels a running download", async () => {
  const model = testModel("test.en", MODEL_BYTES)
  const served = controlledResponse()
  h = await dictationHarness([model], (async () => served.response) as typeof fetch, null)
  const caller = h.caller
  await caller.dictation.downloadModel({ key: "test.en" })
  served.push(MODEL_BYTES.subarray(0, 5))
  await vi.waitFor(async () =>
    expect((await caller.dictation.status()).download.receivedBytes).toBe(5),
  )
  await caller.dictation.cancelDownload()
  await vi.waitFor(async () =>
    expect((await caller.dictation.status()).download.state).toBe("cancelled"),
  )
  const status = await caller.dictation.status()
  expect(status.models[0]?.installed).toBe(false)
  expect(readdirSync(join(h.dataDir, "dictation", "models"))).toEqual([])
})

/** Mocked HTTP: only installed models can be selected; deleting the selected one clears it. */
test("selects, deletes and changes output action", async () => {
  const english = testModel("test.en", MODEL_BYTES)
  const multi = testModel("test", Buffer.from("another fake model"))
  const bodies: Record<string, Buffer> = {
    [english.url]: MODEL_BYTES,
    [multi.url]: Buffer.from("another fake model"),
  }
  h = await dictationHarness(
    [english, multi],
    (async (url: string) => new Response(bodies[url])) as typeof fetch,
    null,
  )
  const caller = h.caller
  await expect(caller.dictation.selectModel({ key: "test" })).rejects.toThrow(/not installed/)
  for (const key of ["test.en", "test"]) {
    await caller.dictation.downloadModel({ key })
    await vi.waitFor(async () =>
      expect((await caller.dictation.status()).download.state).toBe("complete"),
    )
  }
  expect((await caller.dictation.status()).selectedModel).toBe("test.en")
  await caller.dictation.selectModel({ key: "test" })
  expect((await caller.dictation.status()).selectedModel).toBe("test")
  await caller.dictation.deleteModel({ key: "test" })
  const status = await caller.dictation.status()
  expect(status.selectedModel).toBe("test.en")
  expect(status.models.map((model) => [model.key, model.installed])).toEqual([
    ["test.en", true],
    ["test", false],
  ])
  expect(status.outputAction).toBe("insert")
  await caller.dictation.setOutputAction({ action: "review" })
  expect((await caller.dictation.status()).outputAction).toBe("review")
})

test("stores the waveform style, dots by default", async () => {
  h = await dictationHarness([], (async () => new Response("")) as typeof fetch, null)
  const caller = h.caller
  expect((await caller.dictation.status()).waveformStyle).toBe("dots")
  await caller.dictation.setWaveformStyle({ style: "ascii" })
  expect((await caller.dictation.status()).waveformStyle).toBe("ascii")
  await caller.dictation.setOutputAction({ action: "copy" })
  expect((await caller.dictation.status()).waveformStyle).toBe("ascii")
  await caller.dictation.setWaveformStyle({ style: "bars" })
  expect((await caller.dictation.status()).waveformStyle).toBe("bars")
  await caller.dictation.setWaveformStyle({ style: "ascii-art" })
  expect((await caller.dictation.status()).waveformStyle).toBe("ascii-art")
  await expect(caller.dictation.setWaveformStyle({ style: "sine" as "dots" })).rejects.toThrow()
})

/** Mocked engine: transcriptions are saved, capped at 100, searchable and removable. */
test("keeps the newest 100 transcriptions and searches them", async () => {
  const model = testModel("test.en", MODEL_BYTES)
  const engine = fakeEngine("  hello world  ")
  h = await dictationHarness(
    [model],
    (async () => new Response(MODEL_BYTES)) as typeof fetch,
    engine,
  )
  const caller = h.caller
  await expect(caller.dictation.transcribe({ wavBase64: "AAAA" })).rejects.toThrow(/model/)
  await caller.dictation.downloadModel({ key: "test.en" })
  await vi.waitFor(async () =>
    expect((await caller.dictation.status()).download.state).toBe("complete"),
  )
  expect(await caller.dictation.prepare()).toEqual({ state: "ready", error: null })
  expect(engine.prepared[0]).toMatch(/ggml-test\.en\.bin$/)

  const result = await caller.dictation.transcribe({ wavBase64: "AAAA" })
  expect(result).toEqual({ text: "hello world", modelKey: "test.en" })
  // Transcribing alone saves nothing; the renderer saves the text it accepts.
  expect(await caller.dictation.history.list({ query: null })).toHaveLength(0)
  const first = await caller.dictation.history.add(result)
  for (let index = 0; index < 101; index += 1) await caller.dictation.history.add(result)
  const all = await caller.dictation.history.list({ query: null })
  expect(all).toHaveLength(100)
  expect(all.some((entry) => entry.id === first.id)).toBe(false)
  expect(all[0]?.createdAt).toBeGreaterThanOrEqual(all[99]?.createdAt ?? 0)
  expect(all[0]).toMatchObject({ text: "hello world", modelKey: "test.en" })

  expect(await caller.dictation.history.list({ query: "WORLD" })).toHaveLength(100)
  expect(await caller.dictation.history.list({ query: "absent" })).toHaveLength(0)
  expect(await caller.dictation.history.list({ query: "%" })).toHaveLength(0)
  const target = all[0]?.id ?? ""
  await caller.dictation.history.delete({ id: target })
  expect(await caller.dictation.history.list({ query: null })).toHaveLength(99)
  await caller.dictation.history.clear()
  expect(await caller.dictation.history.list({ query: null })).toHaveLength(0)
})

/** Mocked engine: silence produces an error instead of an empty history entry. */
test("reports no speech instead of saving an empty transcription", async () => {
  const model = testModel("test.en", MODEL_BYTES)
  h = await dictationHarness(
    [model],
    (async () => new Response(MODEL_BYTES)) as typeof fetch,
    fakeEngine(" [BLANK_AUDIO] "),
  )
  const caller = h.caller
  await caller.dictation.downloadModel({ key: "test.en" })
  await vi.waitFor(async () =>
    expect((await caller.dictation.status()).download.state).toBe("complete"),
  )
  await expect(caller.dictation.transcribe({ wavBase64: "AAAA" })).rejects.toThrow(/No speech/)
  expect(await caller.dictation.history.list({ query: null })).toHaveLength(0)
})

/** Mocked engine: HTTP 400 (no samples) is no speech; other engine errors pass through. */
test("maps an engine HTTP 400 to no speech and keeps other engine errors", async () => {
  const model = testModel("test.en", MODEL_BYTES)
  const engine = fakeEngine("unused")
  let failure = new EngineHttpError(400, "Invalid request")
  engine.transcribe = async () => {
    throw failure
  }
  h = await dictationHarness(
    [model],
    (async () => new Response(MODEL_BYTES)) as typeof fetch,
    engine,
  )
  const caller = h.caller
  await caller.dictation.downloadModel({ key: "test.en" })
  await vi.waitFor(async () =>
    expect((await caller.dictation.status()).download.state).toBe("complete"),
  )
  await expect(caller.dictation.transcribe({ wavBase64: "AAAA" })).rejects.toThrow(
    /^No speech was detected$/,
  )
  failure = new EngineHttpError(500, "boom")
  await expect(caller.dictation.transcribe({ wavBase64: "AAAA" })).rejects.toThrow(/HTTP 500/)
  expect(await caller.dictation.history.list({ query: null })).toHaveLength(0)
})

/** Mocked engine: a model change restarts a running engine, and it stops when idle. */
test("restarts the engine for a new model and stops it after the idle time", async () => {
  const english = testModel("test.en", MODEL_BYTES)
  const multi = testModel("test", Buffer.from("another fake model"))
  const bodies: Record<string, Buffer> = {
    [english.url]: MODEL_BYTES,
    [multi.url]: Buffer.from("another fake model"),
  }
  const engine = fakeEngine("hello")
  h = await createHarness([], {
    git: false,
    daemon: "lazy",
    httpFetch: (async (url: string) => new Response(bodies[url])) as typeof fetch,
    dictationCatalog: [english, multi],
    dictationEngine: engine,
    dictationIdleMs: 300,
  })
  const caller = h.caller
  for (const key of ["test.en", "test"]) {
    await caller.dictation.downloadModel({ key })
    await vi.waitFor(async () =>
      expect((await caller.dictation.status()).download.state).toBe("complete"),
    )
  }
  await caller.dictation.prepare()
  await caller.dictation.selectModel({ key: "test" })
  await vi.waitFor(() => expect(engine.prepared.at(-1)).toMatch(/ggml-test\.bin$/))
  expect((await caller.dictation.status()).engine.state).toBe("ready")
  await vi.waitFor(
    async () => expect((await caller.dictation.status()).engine.state).toBe("stopped"),
    { timeout: 2000 },
  )
})

/** Mocked HTTP: deleting the selected model selects another installed one. */
test("deleting the selected model selects the recommended installed model, else the smallest", async () => {
  const big = testModel("big", Buffer.from("a big fake model, longer than the others"))
  const small = testModel("small", Buffer.from("small"))
  const recommended = testModel("test.en", MODEL_BYTES)
  const bodies: Record<string, Buffer> = {
    [big.url]: Buffer.from("a big fake model, longer than the others"),
    [small.url]: Buffer.from("small"),
    [recommended.url]: MODEL_BYTES,
  }
  h = await dictationHarness(
    [big, small, recommended],
    (async (url: string) => new Response(bodies[url])) as typeof fetch,
    null,
  )
  const caller = h.caller
  for (const key of ["big", "small", "test.en"]) await install(caller, key)
  await caller.dictation.selectModel({ key: "big" })
  await caller.dictation.deleteModel({ key: "big" })
  expect((await caller.dictation.status()).selectedModel).toBe("test.en")
  await install(caller, "big")
  await caller.dictation.deleteModel({ key: "test.en" })
  expect((await caller.dictation.status()).selectedModel).toBe("small")
  await caller.dictation.deleteModel({ key: "small" })
  expect((await caller.dictation.status()).selectedModel).toBe("big")
  await caller.dictation.deleteModel({ key: "big" })
  expect((await caller.dictation.status()).selectedModel).toBeNull()
})

/** Mocked engine: a model that fails to load reports the engine's own error from prepare. */
test("prepare returns the engine's load error", async () => {
  const model = testModel("test.en", MODEL_BYTES)
  const engine = fakeEngine("unused")
  let status: EngineStatus = { state: "stopped", error: null }
  engine.status = () => status
  engine.prepare = async () => {
    status = { state: "failed", error: "The dictation engine stopped (exit code 1). bad magic" }
    throw new Error(status.error ?? "")
  }
  h = await dictationHarness(
    [model],
    (async () => new Response(MODEL_BYTES)) as typeof fetch,
    engine,
  )
  await install(h.caller, "test.en")
  expect(await h.caller.dictation.prepare()).toEqual({
    state: "failed",
    error: "The dictation engine stopped (exit code 1). bad magic",
  })
})

/** Mocked HTTP: a download that sends no data for the stall time fails and leaves nothing. */
test("fails a download that stalls and removes the staging file", async () => {
  const model = testModel("test.en", MODEL_BYTES)
  const served = controlledResponse()
  h = await createHarness([], {
    git: false,
    daemon: "lazy",
    httpFetch: (async () => served.response) as typeof fetch,
    dictationCatalog: [model],
    dictationEngine: null,
    dictationDownloadStallMs: 300,
  })
  const caller = h.caller
  await caller.dictation.downloadModel({ key: "test.en" })
  served.push(MODEL_BYTES.subarray(0, 5))
  await vi.waitFor(
    async () =>
      expect((await caller.dictation.status()).download).toMatchObject({
        state: "failed",
        error: expect.stringMatching(/^Download stalled/),
      }),
    { timeout: 3000 },
  )
  expect(readdirSync(join(h.dataDir, "dictation", "models"))).toEqual([])
})

/** Mocked HTTP: on start the service removes partial downloads left by an earlier run. */
test("service start removes leftover partial downloads, but not while a download runs", async () => {
  const model = testModel("test.en", MODEL_BYTES)
  const modelsDir = await mkdtemp(join(tmpdir(), "pi-lab-dictation-models-"))
  await writeFile(join(modelsDir, ".ggml-old.partial"), "left by a crash")
  await writeFile(join(modelsDir, "ggml-other.bin"), "an installed model")
  const served = controlledResponse()
  h = await createHarness([], {
    git: false,
    daemon: "lazy",
    httpFetch: (async () => served.response) as typeof fetch,
    dictationCatalog: [model],
    dictationModelsDir: modelsDir,
    dictationEngine: null,
  })
  expect(readdirSync(modelsDir)).toEqual(["ggml-other.bin"])

  await h.caller.dictation.downloadModel({ key: "test.en" })
  served.push(MODEL_BYTES.subarray(0, 5))
  await vi.waitFor(async () =>
    expect((await h?.caller.dictation.status())?.download.receivedBytes).toBe(5),
  )
  await h.dictation.start()
  expect(readdirSync(modelsDir).sort()).toEqual([".ggml-test.en.bin.partial", "ggml-other.bin"])
  served.push(MODEL_BYTES.subarray(5))
  served.end()
  await vi.waitFor(async () =>
    expect((await h?.caller.dictation.status())?.download.state).toBe("complete"),
  )
  await rm(modelsDir, { recursive: true, force: true })
})

/** Real process: service start kills a whisper-server recorded by a run that crashed. */
test("service start kills a leftover whisper-server recorded in the PID file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-dictation-pid-"))
  const pidFile = join(dir, "dictation", "whisper-server.pid")
  await mkdir(join(dir, "dictation"))
  const leftoverPath = join(dir, "whisper-server")
  await symlink("/bin/sleep", leftoverPath)
  const leftover = spawn(leftoverPath, ["60"], { stdio: "ignore" })
  const exited = new Promise((resolve) => leftover.once("exit", resolve))
  await writeFile(pidFile, String(leftover.pid))
  h = await createHarness([], {
    git: false,
    daemon: "lazy",
    dictationEngine: null,
    dictationEnginePidFile: pidFile,
  })
  await expect(
    Promise.race([exited, new Promise((r) => setTimeout(() => r("alive"), 3000))]),
  ).resolves.not.toBe("alive")
  expect(existsSync(pidFile)).toBe(false)
  if (leftover.exitCode === null) leftover.kill()
  await rm(dir, { recursive: true, force: true })
})
