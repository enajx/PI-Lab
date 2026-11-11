/**
 * AudioWorklet processor for dictation: copies the first input channel and posts it to
 * the page in blocks of about 2048 frames. A "flush" message posts what is left and then
 * "flushed", so the page knows it has every sample before it encodes the recording.
 */
const BLOCK_FRAMES = 2048

class DictationCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(BLOCK_FRAMES)
    this.filled = 0
    this.port.onmessage = (event) => {
      if (event.data !== "flush") return
      if (this.filled > 0) this.port.postMessage(this.block.slice(0, this.filled))
      this.filled = 0
      this.port.postMessage("flushed")
    }
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    let offset = 0
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, BLOCK_FRAMES - this.filled)
      this.block.set(channel.subarray(offset, offset + count), this.filled)
      this.filled += count
      offset += count
      if (this.filled === BLOCK_FRAMES) {
        this.port.postMessage(this.block.slice())
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor("dictation-capture", DictationCaptureProcessor)
