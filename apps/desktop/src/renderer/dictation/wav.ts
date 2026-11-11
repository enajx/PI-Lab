/**
 * Audio helpers for dictation: turn captured microphone samples (float, at the audio
 * context's rate) into the 16 kHz mono 16-bit PCM WAV that whisper.cpp reads.
 */

/** The sample rate whisper.cpp expects. */
export const WHISPER_SAMPLE_RATE = 16_000

/**
 * Resample mono float samples from `fromRate` to `toRate`. When downsampling, each output
 * sample is the mean of the input samples in a window centered on it, which removes most
 * of the content above the new Nyquist frequency before it can alias.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice()
  const ratio = fromRate / toRate
  const length = Math.floor((input.length * toRate) / fromRate)
  const output = new Float32Array(length)
  if (ratio > 1) {
    const half = ratio / 2
    for (let i = 0; i < length; i += 1) {
      const center = i * ratio
      const start = Math.max(0, Math.ceil(center - half))
      const end = Math.min(input.length - 1, Math.floor(center + half))
      let sum = 0
      for (let j = start; j <= end; j += 1) sum += input[j] ?? 0
      output[i] = end >= start ? sum / (end - start + 1) : 0
    }
    return output
  }
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio
    const left = Math.floor(position)
    const right = Math.min(left + 1, input.length - 1)
    const weight = position - left
    output[i] = (input[left] ?? 0) * (1 - weight) + (input[right] ?? 0) * weight
  }
  return output
}

/** Encode mono float samples (-1..1, clamped) as a 16-bit PCM WAV file. */
export function encodeWav16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const writeText = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i)
  }
  writeText(0, "RIFF")
  view.setUint32(4, 36 + dataBytes, true)
  writeText(8, "WAVE")
  writeText(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, "data")
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : Math.round(sample * 0x7fff), true)
  }
  return bytes
}

/** Standard base64 of a byte array, built in chunks so long recordings do not overflow the stack. */
export function base64FromBytes(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/** Root mean square of a block of samples: the loudness the listening wave follows. */
export function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / samples.length)
}

/** Samples per block when measuring loudness; the capture worklet posts blocks of this size. */
export const LEVEL_BLOCK_FRAMES = 2048

/**
 * Block RMS a recording must reach once to count as speech. Measured with blocks of 2048
 * samples: the hello-world fixture file peaks at 0.21; played through Chromium's fake
 * microphone with echo cancellation and noise suppression on, it peaks at 0.26 and the
 * silence around it is 0. 0.01 is well below the speech and above silence. A real room's
 * background noise was not measured. Below the threshold whisper only invents text
 * (1 s of silence gives " you"), so the recording is not sent.
 */
export const SPEECH_LEVEL = 0.01

/** The highest RMS over consecutive blocks of {@link LEVEL_BLOCK_FRAMES} samples. */
export function peakBlockLevel(samples: Float32Array): number {
  let peak = 0
  for (let offset = 0; offset < samples.length; offset += LEVEL_BLOCK_FRAMES) {
    peak = Math.max(peak, rmsLevel(samples.subarray(offset, offset + LEVEL_BLOCK_FRAMES)))
  }
  return peak
}

/** Whether any block of the recording is loud enough to be speech. */
export function speechDetected(samples: Float32Array): boolean {
  return peakBlockLevel(samples) >= SPEECH_LEVEL
}
