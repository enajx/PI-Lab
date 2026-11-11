import type { DictationWaveformStyle } from "@pi-lab/local-db"
import { useEffect, useRef } from "react"

/** Shape of each style: canvas size in CSS pixels and the width of one column. */
const DOTS = { width: 144, height: 27, pitch: 3, cell: 2, rows: 9 }
const BARS = { width: 144, height: 28, pitch: 5, bar: 3 }
const ASCII = { columns: 16, pitch: 9.2 }
/** Must match the font size and line height of `.dictation-wave-ascii-art`. */
const ASCII_ART = { columns: 24, rows: 5, pitch: 5.8 }
/** How fast the level history moves to the left, in CSS pixels per second. */
const SCROLL_SPEED = 60
const BLOCKS = " ▁▂▃▄▅▆▇█"

/**
 * The listening waveform: a history of recent microphone levels, mirrored around the
 * middle and moving to the left, in the theme accent color. Drawn on every animation
 * frame without React re-renders. Under `prefers-reduced-motion` the columns do not
 * move; they all follow the current level.
 */
export function Waveform({ style, level }: { style: DictationWaveformStyle; level: () => number }) {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const top = useRef<HTMLSpanElement | null>(null)
  const bottom = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    const { columns, pitch } = layout(style)
    const sampleMs = (pitch * 1000) / SCROLL_SPEED
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
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
      if (still) {
        for (let i = 0; i < columns; i += 1) history[i] = shown * stillProfile(i, columns)
      } else if (now - lastSample >= sampleMs) {
        lastSample = now
        history.shift()
        history.push(peak)
        peak = shown
      }
      if (style === "ascii") {
        const line = asciiLine(history)
        if (top.current) top.current.textContent = line
        if (bottom.current) bottom.current.textContent = line
      } else if (style === "ascii-art") {
        if (top.current) top.current.textContent = asciiArt(history)
      } else if (canvas.current) {
        const context = prepareCanvas(canvas.current)
        if (style === "dots") drawDots(context, history)
        else drawBars(context, history)
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [style, level])

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
  if (style === "ascii") {
    return (
      <span
        data-testid="dictation-wave"
        data-style={style}
        role="img"
        aria-label="Microphone level"
        className="dictation-wave-ascii"
      >
        <span ref={top} />
        <span ref={bottom} />
      </span>
    )
  }
  const size = style === "dots" ? DOTS : BARS
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
  if (style === "ascii") return { columns: ASCII.columns, pitch: ASCII.pitch }
  if (style === "ascii-art") return { columns: ASCII_ART.columns, pitch: ASCII_ART.pitch }
  const size = style === "dots" ? DOTS : BARS
  return { columns: Math.floor(size.width / size.pitch), pitch: size.pitch }
}

/** A fixed uneven shape, highest in the middle, for the columns when nothing moves. */
function stillProfile(index: number, columns: number): number {
  const t = (index + 0.5) / columns
  return Math.sin(Math.PI * t) ** 0.7 * (0.65 + 0.35 * Math.abs(Math.sin(index * 2.3)))
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
  context.fillStyle = getComputedStyle(element).color
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

/** Rounded bars mirrored around the middle line. */
function drawBars(context: CanvasRenderingContext2D, history: readonly number[]): void {
  const { height, pitch, bar } = BARS
  history.forEach((value, index) => {
    const length = Math.max(bar, value * height)
    context.globalAlpha = edgeFade(index, history.length)
    context.beginPath()
    context.roundRect(index * pitch + 1, (height - length) / 2, bar, length, bar / 2)
    context.fill()
  })
  context.globalAlpha = 1
}

/**
 * One line of block characters, one per column. The pill shows it twice: the top line
 * grows up from the middle, and the bottom one is flipped by CSS so it grows down.
 */
function asciiLine(history: readonly number[]): string {
  const steps = BLOCKS.length - 1
  return history.map((value) => BLOCKS[Math.max(1, Math.round(value * steps))]).join("")
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
