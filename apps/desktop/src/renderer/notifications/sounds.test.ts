import { describe, expect, test, vi } from "vitest"
import { playNotificationSound } from "./sounds"

class FakeAudioParam {
  setValueAtTime = vi.fn()
  exponentialRampToValueAtTime = vi.fn()
}

class FakeNode {
  connect = vi.fn()
}

class FakeOscillator extends FakeNode {
  type: OscillatorType = "sine"
  frequency = new FakeAudioParam()
  start = vi.fn()
  stop = vi.fn()
}

class FakeGain extends FakeNode {
  gain = new FakeAudioParam()
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  currentTime = 10
  state: AudioContextState = "running"
  destination = new FakeNode() as unknown as AudioDestinationNode
  oscillators: FakeOscillator[] = []
  resume = vi.fn(async () => undefined)
  close = vi.fn(async () => {
    this.state = "closed"
  })

  constructor() {
    FakeAudioContext.instances.push(this)
  }

  createOscillator(): OscillatorNode {
    const oscillator = new FakeOscillator()
    this.oscillators.push(oscillator)
    return oscillator as unknown as OscillatorNode
  }

  createGain(): GainNode {
    return new FakeGain() as unknown as GainNode
  }
}

describe("playNotificationSound", () => {
  test("does not construct an audio context while delivery is suppressed", async () => {
    FakeAudioContext.instances = []
    const result = await playNotificationSound("chime", {
      suppressed: true,
      audioContext: FakeAudioContext as unknown as new () => AudioContext,
    })
    expect(result).toEqual({ status: "suppressed" })
    expect(FakeAudioContext.instances).toHaveLength(0)
  })

  test("treats Silent as an explicit no-audio result", async () => {
    const result = await playNotificationSound("silent", {
      suppressed: false,
      audioContext: FakeAudioContext as unknown as new () => AudioContext,
    })
    expect(result).toEqual({ status: "silent" })
  })

  test("plays the bundled recipe and closes its context", async () => {
    vi.useFakeTimers()
    FakeAudioContext.instances = []
    const pending = playNotificationSound("success", {
      suppressed: false,
      audioContext: FakeAudioContext as unknown as new () => AudioContext,
    })
    await vi.runAllTimersAsync()
    expect(await pending).toEqual({ status: "played" })
    expect(FakeAudioContext.instances[0]?.oscillators).toHaveLength(3)
    expect(FakeAudioContext.instances[0]?.close).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  test("returns a failure instead of throwing when audio startup fails", async () => {
    class BrokenAudioContext extends FakeAudioContext {
      override resume = vi.fn(async () => {
        throw new Error("device unavailable")
      })
    }
    const result = await playNotificationSound("alert", {
      suppressed: false,
      audioContext: BrokenAudioContext as unknown as new () => AudioContext,
    })
    expect(result.status).toBe("failed")
    if (result.status === "failed") expect(result.error.message).toBe("device unavailable")
  })
})
