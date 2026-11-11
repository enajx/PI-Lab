import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { startRecording } from "./recorder"

// Mocked Web Audio and microphone: jsdom has neither. The fake worklet node answers a
// "flush" with `reply` (blocks, then "flushed"), or not at all when `reply` is null.

class FakeTrack {
  readyState: "live" | "ended" = "live"
  stop(): void {
    this.readyState = "ended"
  }
}

let tracks: FakeTrack[] = []
let contexts: FakeContext[] = []
let reply: Array<Float32Array | "flushed"> | null = null

class FakeContext {
  sampleRate = 48_000
  state: "running" | "closed" = "running"
  destination = {}
  audioWorklet = { addModule: async () => {} }
  constructor() {
    contexts.push(this)
  }
  createMediaStreamSource() {
    return { connect: () => {}, disconnect: () => {} }
  }
  createGain() {
    return { gain: { value: 1 }, connect: () => {} }
  }
  close(): Promise<void> {
    this.state = "closed"
    return Promise.resolve()
  }
}

class FakeWorkletNode {
  port: { onmessage: ((event: MessageEvent) => void) | null; postMessage: (data: string) => void }
  constructor() {
    const port: FakeWorkletNode["port"] = {
      onmessage: null,
      postMessage: (data) => {
        if (data !== "flush" || !reply) return
        for (const message of reply) port.onmessage?.({ data: message } as MessageEvent)
      },
    }
    this.port = port
  }
  connect(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  tracks = [new FakeTrack()]
  contexts = []
  reply = null
  vi.stubGlobal("AudioContext", FakeContext)
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode)
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => tracks }) },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const released = (): boolean =>
  tracks.every((track) => track.readyState === "ended") &&
  contexts.every((context) => context.state === "closed")

test("stop returns the WAV and whether the recording reached speech level (mocked Web Audio)", async () => {
  reply = [new Float32Array(2048).fill(0.2), "flushed"]
  const loud = await (await startRecording()).stop()
  expect(loud.speech).toBe(true)
  expect(atob(loud.wavBase64).slice(0, 4)).toBe("RIFF")
  expect(released()).toBe(true)

  reply = [new Float32Array(2048), "flushed"]
  expect((await (await startRecording()).stop()).speech).toBe(false)
})

test("stop fails after 2 s when the capture worklet never answers, and releases the microphone (mocked Web Audio)", async () => {
  vi.useFakeTimers()
  const recording = await startRecording()
  const stopped = recording.stop()
  const outcome = expect(stopped).rejects.toThrow(/did not finish within 2 s/)
  await vi.advanceTimersByTimeAsync(2_000)
  await outcome
  expect(released()).toBe(true)
})

test("cancel while stop waits for the worklet ends the stop and releases everything (mocked Web Audio)", async () => {
  const recording = await startRecording()
  const stopped = recording.stop()
  recording.cancel()
  await expect(stopped).rejects.toThrow(/cancelled/)
  expect(released()).toBe(true)
})
