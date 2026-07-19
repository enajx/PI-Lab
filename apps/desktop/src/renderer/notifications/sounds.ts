/**
 * PI Lab's original notification sounds. These short Web Audio recipes are the
 * canonical bundled assets: they ship in the renderer bundle, need no decoded
 * files, and are not derived from third-party recordings.
 */
export const NOTIFICATION_SOUND_IDS = ["chime", "pulse", "success", "alert", "silent"] as const

export type NotificationSoundId = (typeof NOTIFICATION_SOUND_IDS)[number]

export const NOTIFICATION_SOUND_OPTIONS: ReadonlyArray<{
  id: NotificationSoundId
  label: string
}> = [
  { id: "chime", label: "Chime" },
  { id: "pulse", label: "Pulse" },
  { id: "success", label: "Success" },
  { id: "alert", label: "Alert" },
  { id: "silent", label: "Silent" },
]

interface Tone {
  frequency: number
  offset: number
  duration: number
  gain: number
  wave: OscillatorType
}

const SOUND_RECIPES: Readonly<Record<Exclude<NotificationSoundId, "silent">, readonly Tone[]>> = {
  chime: [
    { frequency: 659.25, offset: 0, duration: 0.16, gain: 0.13, wave: "sine" },
    { frequency: 987.77, offset: 0.1, duration: 0.24, gain: 0.1, wave: "sine" },
  ],
  pulse: [
    { frequency: 440, offset: 0, duration: 0.1, gain: 0.1, wave: "triangle" },
    { frequency: 554.37, offset: 0.13, duration: 0.1, gain: 0.09, wave: "triangle" },
  ],
  success: [
    { frequency: 523.25, offset: 0, duration: 0.12, gain: 0.1, wave: "sine" },
    { frequency: 659.25, offset: 0.09, duration: 0.14, gain: 0.11, wave: "sine" },
    { frequency: 783.99, offset: 0.19, duration: 0.2, gain: 0.1, wave: "sine" },
  ],
  alert: [
    { frequency: 392, offset: 0, duration: 0.13, gain: 0.11, wave: "square" },
    { frequency: 311.13, offset: 0.15, duration: 0.18, gain: 0.09, wave: "square" },
  ],
}

export type NotificationSoundResult =
  | { status: "played" }
  | { status: "silent" }
  | { status: "suppressed" }
  | { status: "failed"; error: Error }

type AudioContextConstructor = new () => AudioContext

interface PlayNotificationSoundOptions {
  suppressed: boolean
  audioContext?: AudioContextConstructor
}

/**
 * Play one bundled sound without allowing a missing/blocked audio device to
 * disrupt notification delivery. Callers still receive an explicit outcome so
 * previews can surface failures and runtime delivery can log them.
 */
export async function playNotificationSound(
  sound: NotificationSoundId,
  options: PlayNotificationSoundOptions,
): Promise<NotificationSoundResult> {
  if (options.suppressed) return { status: "suppressed" }
  if (sound === "silent") return { status: "silent" }

  const AudioContextType = options.audioContext ?? window.AudioContext ?? window.webkitAudioContext
  if (!AudioContextType) {
    return { status: "failed", error: new Error("Web Audio is unavailable") }
  }

  let context: AudioContext | null = null
  try {
    context = new AudioContextType()
    await context.resume()
    const now = context.currentTime
    let end = now

    for (const tone of SOUND_RECIPES[sound]) {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      const start = now + tone.offset
      const stop = start + tone.duration
      oscillator.type = tone.wave
      oscillator.frequency.setValueAtTime(tone.frequency, start)
      gain.gain.setValueAtTime(tone.gain, start)
      gain.gain.exponentialRampToValueAtTime(0.0001, stop)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(start)
      oscillator.stop(stop)
      end = Math.max(end, stop)
    }

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, Math.ceil((end - now) * 1_000) + 20)
    })
    await context.close()
    return { status: "played" }
  } catch (cause) {
    if (context && context.state !== "closed") await context.close().catch(() => undefined)
    const error = cause instanceof Error ? cause : new Error(String(cause))
    return { status: "failed", error }
  }
}

declare global {
  interface Window {
    webkitAudioContext?: AudioContextConstructor
  }
}
