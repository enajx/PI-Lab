import type { DictationWaveformStyle } from "@pi-lab/local-db"
import { useEffect, useRef } from "react"

/** Shape of each style: canvas size in CSS pixels and the width of one column. */
const DOTS = { width: 144, height: 27, pitch: 3, cell: 2, rows: 9 }
/** Must match the font size and line height of `.dictation-wave-ascii-art`. */
const ASCII_ART = { columns: 24, rows: 5, pitch: 5.8 }
/** How fast the level history moves to the left, in CSS pixels per second. */
const SCROLL_SPEED = 55
/** Canvas size of the "lines" style, and the gap kept above and below. */
const LINES = { width: 144, height: 28, margin: 1.5 }
/** The smallest wave amplitude, so the lines still move a little in silence. */
const IDLE_AMPLITUDE = 0.04

/** One of the layered waves of the "lines" style. */
export interface WaveLine {
  /** Sine cycles across the width. */
  cycles: number
  /** How fast the wave moves, in radians per second (negative moves it to the right). */
  speed: number
  /** Share of the full height the wave reaches at full level. */
  gain: number
  /** Opacity of the line. */
  alpha: number
  /** Stroke width in CSS pixels. */
  width: number
  /** Index of the speech band (`SPEECH_BANDS` in wav.ts) that drives this line. */
  band: number
}

/** The layered waves, from the main line to the faintest one. */
export const WAVE_LINES: readonly WaveLine[] = [
  { cycles: 1.7, speed: 4, gain: 1, alpha: 1, width: 1.5, band: 1 },
  { cycles: 2.4, speed: -5, gain: 0.8, alpha: 0.6, width: 1.25, band: 0 },
  { cycles: 3.3, speed: 6, gain: 0.6, alpha: 0.42, width: 1, band: 2 },
  { cycles: 4.6, speed: -7, gain: 0.45, alpha: 0.3, width: 1, band: 3 },
]

/**
 * The listening waveform in the theme accent color, drawn on every animation frame
 * without React re-renders. "dots" and "ascii-art" show a history of recent microphone
 * levels that drifts to the left, also when the system asks for reduced motion; "lines"
 * oscillates in place.
 */
export function Waveform({
  style,
  level,
  bands,
}: {
  style: DictationWaveformStyle
  level: () => number
  bands: () => readonly number[]
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const top = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    if (style === "lines") return animateLines(level, bands, canvas)
    const { columns, pitch } = layout(style)
    const sampleMs = (pitch * 1000) / SCROLL_SPEED
    const history = new Array<number>(columns).fill(0)
    let shown = 0
    let peak = 0
    let lastSample = performance.now()
    let frame = 0
    const draw = (now: number): void => {
      // Speech RMS sits around 0.02 to 0.2; a square root keeps quiet speech visible.
      const target = Math.min(1, Math.sqrt(level()) * 2.4)
      shown += (target - shown) * (target > shown ? 0.4 : 0.15)
      peak = Math.max(peak, shown)
      if (now - lastSample >= sampleMs) {
        lastSample = now
        history.shift()
        history.push(peak)
        peak = shown
      }
      const shape = travelling(history, now)
      if (style === "ascii-art") {
        if (top.current) top.current.textContent = asciiArt(shape)
      } else if (canvas.current) {
        const context = prepareCanvas(canvas.current)
        drawDots(context, shape)
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [style, level, bands])

  if (style === "ascii-art") {
    return (
      <span
        ref={top}
        data-testid="dictation-wave"
        data-style={style}
        role="img"
        aria-label="Microphone level"
        className="dictation-wave-ascii-art"
      />
    )
  }
  const size = style === "dots" ? DOTS : LINES
  return (
    <canvas
      ref={canvas}
      data-testid="dictation-wave"
      data-style={style}
      role="img"
      aria-label="Microphone level"
      className="dictation-wave-canvas"
      style={{ width: size.width, height: size.height }}
    />
  )
}

/** The number of columns a style shows and the width of one column in CSS pixels. */
function layout(style: DictationWaveformStyle): { columns: number; pitch: number } {
  if (style === "ascii-art") return { columns: ASCII_ART.columns, pitch: ASCII_ART.pitch }
  return { columns: Math.floor(DOTS.width / DOTS.pitch), pitch: DOTS.pitch }
}

/**
 * Multiply the level history by a ripple that moves to the left, so the shape travels
 * across the pill even while the level stays the same.
 */
function travelling(history: readonly number[], now: number): number[] {
  const seconds = now / 1000
  return history.map((value, index) => {
    const x = index / history.length
    const ripple =
      0.5 +
      0.32 * Math.sin(2 * Math.PI * 2.2 * x + 4 * seconds) +
      0.18 * Math.sin(2 * Math.PI * 5.3 * x + 6.5 * seconds)
    return value * Math.max(0.15, Math.min(1, 0.35 + ripple))
  })
}

/** Older columns fade out at the left edge. */
function edgeFade(index: number, columns: number): number {
  return Math.min(1, (index + 1) / (columns * 0.2))
}

/** Size the canvas for the screen's pixel ratio, clear it, and set the accent color. */
function prepareCanvas(element: HTMLCanvasElement): CanvasRenderingContext2D {
  const ratio = window.devicePixelRatio
  const width = Math.round(element.clientWidth * ratio)
  const height = Math.round(element.clientHeight * ratio)
  if (element.width !== width || element.height !== height) {
    element.width = width
    element.height = height
  }
  const context = element.getContext("2d")
  if (!context) throw new Error("The waveform canvas has no 2D context")
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, element.clientWidth, element.clientHeight)
  // The canvas element's CSS color is the theme accent.
  const color = getComputedStyle(element).color
  context.fillStyle = color
  context.strokeStyle = color
  return context
}

/**
 * Dot matrix: each column is a stack of square cells. Lit cells grow out from the middle
 * row with the level and fade toward the top and bottom; unlit cells stay as faint dots.
 */
function drawDots(context: CanvasRenderingContext2D, history: readonly number[]): void {
  const { pitch, cell, rows } = DOTS
  const middle = (rows - 1) / 2
  history.forEach((value, index) => {
    const fade = edgeFade(index, history.length)
    const reach = 0.35 + value * middle
    for (let row = 0; row < rows; row += 1) {
      const distance = Math.abs(row - middle)
      const lit = distance <= reach
      context.globalAlpha = fade * (lit ? 1 - (distance / (middle + 1)) * 0.6 : 0.13)
      context.fillRect(index * pitch, row * pitch, cell, cell)
    }
  })
  context.globalAlpha = 1
}

/**
 * ASCII art like the Raycast Whisper extension's recording view: rows of characters
 * mirrored around the middle row. A cell is drawn when it is within the column's reach,
 * with a character by intensity (1 - distance from the middle / reach): █ ▓ ▒ ░ ·.
 */
function asciiArt(history: readonly number[]): string {
  const middle = (ASCII_ART.rows - 1) / 2
  const lines: string[] = []
  for (let row = 0; row < ASCII_ART.rows; row += 1) {
    const distance = Math.abs(row - middle)
    let line = ""
    for (const value of history) {
      // Cells are measured from their far half, so a quiet column shows only "·".
      const reach = 0.6 + value * (middle + 1.2)
      const intensity = 1 - (distance + 0.5) / reach
      line +=
        distance >= reach
          ? " "
          : intensity > 0.8
            ? "█"
            : intensity > 0.6
              ? "▓"
              : intensity > 0.4
                ? "▒"
                : intensity > 0.2
                  ? "░"
                  : "·"
    }
    lines.push(line)
  }
  return lines.join("\n")
}

/**
 * Run the "lines" waveform until the returned function is called. Each line's amplitude
 * follows the microphone level, weighted by the loudness of its speech band, and its
 * phase moves with time. Lines move in opposite directions, so the waves oscillate in place
 * without drifting.
 */
function animateLines(
  level: () => number,
  bands: () => readonly number[],
  canvas: { current: HTMLCanvasElement | null },
): () => void {
  const amplitudes = WAVE_LINES.map(() => 0)
  // Recent amplitudes per line, newest last: drawn from right (newest) to left (oldest).
  const phases = WAVE_LINES.map((_, index) => index * 1.9)
  let shown = 0
  let last = performance.now()
  let frame = 0
  const draw = (now: number): void => {
    const seconds = Math.min(0.1, (now - last) / 1000)
    last = now
    const target = Math.min(1, Math.sqrt(level()) * 2.4)
    shown += (target - shown) * (target > shown ? 0.4 : 0.15)
    const spectrum = bands()
    WAVE_LINES.forEach((line, index) => {
      const band = spectrum[line.band] ?? 0.5
      const goal = Math.min(1, shown * line.gain * (0.55 + 0.9 * band))
      const current = amplitudes[index] ?? 0
      amplitudes[index] = current + (goal - current) * (goal > current ? 0.25 : 0.08)
      phases[index] = (phases[index] ?? 0) + line.speed * seconds
    })
    if (canvas.current) drawLines(prepareCanvas(canvas.current), amplitudes, phases)
    frame = requestAnimationFrame(draw)
  }
  frame = requestAnimationFrame(draw)
  return () => cancelAnimationFrame(frame)
}

/**
 * The y of a wave at `count` evenly spaced points, in -1..1 (positive is up): a sine with
 * a weaker overtone, scaled by `amplitude` and tapered to 0 at both ends.
 */
export function wavePoints(
  line: WaveLine,
  amplitude: number,
  phase: number,
  count: number,
): number[] {
  const points: number[] = []
  for (let index = 0; index < count; index += 1) {
    const t = index / (count - 1)
    const taper = Math.sin(Math.PI * t) ** 1.5
    const carrier =
      (Math.sin(2 * Math.PI * line.cycles * t + phase) +
        0.25 * Math.sin(2 * Math.PI * line.cycles * 2.1 * t - phase * 1.3)) /
      1.25
    points.push(amplitude * taper * carrier)
  }
  return points
}

/** Stroke every wave line, faintest first, then fade both ends. */
function drawLines(
  context: CanvasRenderingContext2D,
  amplitudes: readonly number[],
  phases: readonly number[],
): void {
  const { width, height, margin } = LINES
  const middle = height / 2
  const reach = middle - margin
  context.lineCap = "round"
  context.lineJoin = "round"
  for (let index = WAVE_LINES.length - 1; index >= 0; index -= 1) {
    const line = WAVE_LINES[index]
    if (!line) continue
    const amplitude = Math.max(IDLE_AMPLITUDE, amplitudes[index] ?? 0)
    const points = wavePoints(line, amplitude, phases[index] ?? 0, width + 1)
    context.globalAlpha = line.alpha
    context.lineWidth = line.width
    context.beginPath()
    points.forEach((y, x) => {
      if (x === 0) context.moveTo(x, middle - y * reach)
      else context.lineTo(x, middle - y * reach)
    })
    context.stroke()
  }
  context.globalAlpha = 1
  fadeEnds(context, width, height)
}

/** Fade the left and right ends of what is drawn to transparent. */
function fadeEnds(context: CanvasRenderingContext2D, width: number, height: number): void {
  const fade = context.createLinearGradient(0, 0, width, 0)
  fade.addColorStop(0, "rgba(0, 0, 0, 0)")
  fade.addColorStop(0.18, "rgba(0, 0, 0, 1)")
  fade.addColorStop(0.82, "rgba(0, 0, 0, 1)")
  fade.addColorStop(1, "rgba(0, 0, 0, 0)")
  context.globalCompositeOperation = "destination-in"
  context.fillStyle = fade
  context.fillRect(0, 0, width, height)
  context.globalCompositeOperation = "source-over"
}
