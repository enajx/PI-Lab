// no-inline: the CSP only allows same-origin scripts, so the worklet must not become a data: URL.
import workletUrl from "./captureWorklet.js?url&no-inline"
import {
  bandLevels,
  base64FromBytes,
  encodeWav16,
  resample,
  rmsLevel,
  speechDetected,
  WHISPER_SAMPLE_RATE,
} from "./wav"

/** How long stop waits for the capture worklet's last samples. */
const FLUSH_TIMEOUT_MS = 2_000

/** A microphone recording in progress. */
export interface Recording {
  /** Loudness (RMS, 0..1) of the most recent block of audio, for the listening wave. */
  level: () => number
  /** Loudness (0..1) of each speech band (`SPEECH_BANDS` in wav.ts) right now, for the "lines" waves. */
  bands: () => readonly number[]
  /**
   * Stop, release the microphone, and return the audio as a base64 16 kHz mono WAV, with
   * whether it ever reached speech level. Fails after {@link FLUSH_TIMEOUT_MS} when the
   * worklet does not send its last samples, or when {@link cancel} is called meanwhile.
   */
  stop: () => Promise<{ wavBase64: string; speech: boolean }>
  /** Stop, release the microphone and the audio context, and discard the audio. */
  cancel: () => void
}

/**
 * Open the microphone and start capturing through an AudioWorklet. The microphone is
 * released as soon as {@link Recording.stop} or {@link Recording.cancel} is called.
 */
export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  })
  const context = new AudioContext()
  const release = (): void => {
    for (const track of stream.getTracks()) track.stop()
    void context.close()
  }
  // Release the microphone if the worklet cannot load, then let the error reach the caller.
  await context.audioWorklet.addModule(workletUrl).catch((error: unknown) => {
    release()
    throw error
  })

  const source = context.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(context, "dictation-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
  })
  // A silent path to the speakers keeps the worklet running without playing anything.
  const mute = context.createGain()
  mute.gain.value = 0
  source.connect(node)
  node.connect(mute)
  // Only read for the listening wave: a spectrum of the microphone, nothing is played.
  const analyser = context.createAnalyser()
  analyser.fftSize = 2048
  analyser.minDecibels = -90
  analyser.maxDecibels = -25
  analyser.smoothingTimeConstant = 0.6
  source.connect(analyser)
  const spectrum = new Uint8Array(analyser.frequencyBinCount)
  mute.connect(context.destination)

  const chunks: Float32Array[] = []
  let latestLevel = 0
  let onFlushed: (() => void) | null = null
  /** Ends a stop that is waiting for the worklet; set while it waits. */
  let abortStop: ((error: Error) => void) | null = null
  node.port.onmessage = (event: MessageEvent<Float32Array | "flushed">) => {
    if (event.data === "flushed") {
      onFlushed?.()
      return
    }
    chunks.push(event.data)
    latestLevel = rmsLevel(event.data)
  }

  let closed = false
  const disconnect = (): void => {
    if (closed) return
    closed = true
    node.port.onmessage = null
    source.disconnect()
    node.disconnect()
    analyser.disconnect()
    release()
    abortStop?.(new Error("The recording was cancelled"))
  }

  return {
    level: () => latestLevel,
    bands: () => {
      analyser.getByteFrequencyData(spectrum)
      return bandLevels(spectrum, context.sampleRate)
    },
    stop: async () => {
      // Stop the microphone right away; the worklet still holds the last partial block.
      for (const track of stream.getTracks()) track.stop()
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          abortStop = null
          disconnect()
          reject(
            new Error(
              `The microphone recording did not finish within ${FLUSH_TIMEOUT_MS / 1000} s: the audio capture sent no final samples.`,
            ),
          )
        }, FLUSH_TIMEOUT_MS)
        abortStop = (error) => {
          window.clearTimeout(timer)
          abortStop = null
          reject(error)
        }
        onFlushed = () => {
          window.clearTimeout(timer)
          abortStop = null
          resolve()
        }
        node.port.postMessage("flush")
      })
      const sampleRate = context.sampleRate
      disconnect()
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const samples = new Float32Array(total)
      let offset = 0
      for (const chunk of chunks) {
        samples.set(chunk, offset)
        offset += chunk.length
      }
      const wav = encodeWav16(
        resample(samples, sampleRate, WHISPER_SAMPLE_RATE),
        WHISPER_SAMPLE_RATE,
      )
      return { wavBase64: base64FromBytes(wav), speech: speechDetected(samples) }
    },
    cancel: disconnect,
  }
}
