import { useEffect, useRef } from "react"
import type { DigitalRainDensity, DigitalRainSpeed } from "../../../../../preferences/preferences"

interface RainStream {
  glyphOffset: number
  headY: number
  speed: number
  x: number
}

const FALLBACK_CHARACTERS = "01<>[]{}()#$%*+=-:;/."
const FRAME_RATE: Record<DigitalRainSpeed, number> = { slow: 10, normal: 15, fast: 20 }
const STREAM_COUNT: Record<DigitalRainDensity, number> = { sparse: 5, normal: 8, dense: 11 }
const TRAIL_LENGTH: Record<DigitalRainDensity, number> = { sparse: 5, normal: 7, dense: 9 }
// In a 128px card header these speeds advance roughly 0.4, 0.7, or 1.2 glyph
// rows per frame. They make the fall visibly legible without increasing the
// fixed 10–20 FPS rendering budget.
const BASE_SPEED: Record<DigitalRainSpeed, number> = { slow: 70, normal: 120, fast: 200 }

/** Tiny deterministic PRNG: no per-frame allocations or Math.random calls. */
function createRandom(seed: number): () => number {
  let state = seed || 0x6d2b79f5
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

/**
 * A compact, canvas-only Digital Rain thumbnail. It models only a capped number
 * of falling streams; when its project is idle or the page is hidden, it paints
 * once and owns no timer. Working cards alone animate, so the working signal is
 * never silently suppressed by browser visibility heuristics or system motion
 * preferences while the timer budget remains bounded by active projects.
 */
export function DigitalRainThumbnail({
  characters,
  density,
  speed,
  animate,
}: {
  characters: string | undefined
  density: DigitalRainDensity
  speed: DigitalRainSpeed
  /** True only while this project's agent state is working. */
  animate: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext("2d")
    if (!context) return

    const characterPool = characters && characters.length > 0 ? characters : FALLBACK_CHARACTERS
    const random = createRandom(
      Array.from(characterPool).reduce((seed, character) => seed ^ character.charCodeAt(0), 0),
    )
    const streams: RainStream[] = []
    let width = 0
    let height = 0
    let fontSize = 10
    let lineHeight = 11
    let running = false
    let frame: number | null = null
    let timer: number | null = null
    let lastFrameAt = performance.now()

    const draw = () => {
      context.fillStyle = "#000"
      context.fillRect(0, 0, width, height)
      context.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`
      context.textAlign = "center"
      context.textBaseline = "middle"
      const trailLength = TRAIL_LENGTH[density]
      for (const stream of streams) {
        for (let position = trailLength - 1; position >= 0; position -= 1) {
          const y = stream.headY - position * lineHeight
          if (y < -lineHeight || y > height + lineHeight) continue
          const brightness = position === 0 ? 1 : 0.2 + (1 - position / trailLength) * 0.58
          context.fillStyle = `rgb(${Math.round(brightness * 255)} ${Math.round(brightness * 255)} ${Math.round(brightness * 255)})`
          const glyphIndex = stream.glyphOffset + position + Math.floor(stream.headY / lineHeight)
          const character =
            characterPool[
              ((glyphIndex % characterPool.length) + characterPool.length) % characterPool.length
            ]
          context.fillText(character ?? "0", stream.x, y)
        }
      }
    }

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = Math.max(1, Math.round(rect.width || canvas.clientWidth || 320))
      height = Math.max(1, Math.round(rect.height || canvas.clientHeight || 128))
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      fontSize = Math.max(7, Math.min(12, Math.floor(width / (STREAM_COUNT[density] + 7))))
      lineHeight = Math.round(fontSize * 1.18)
      streams.length = 0
      for (let index = 0; index < STREAM_COUNT[density]; index += 1) {
        streams.push({
          glyphOffset: Math.floor(random() * characterPool.length),
          headY: random() * (height + TRAIL_LENGTH[density] * lineHeight),
          speed: BASE_SPEED[speed] * (0.72 + random() * 0.56),
          x: ((index + 0.5) / STREAM_COUNT[density]) * width,
        })
      }
      draw()
    }

    const step = (elapsedMs: number) => {
      for (const stream of streams) {
        stream.headY += stream.speed * (elapsedMs / 1000)
        if (stream.headY > height + TRAIL_LENGTH[density] * lineHeight) {
          stream.headY = -random() * height * 0.45
          stream.glyphOffset = Math.floor(random() * characterPool.length)
        }
      }
    }

    const stop = () => {
      running = false
      if (frame !== null) window.cancelAnimationFrame(frame)
      if (timer !== null) window.clearTimeout(timer)
      frame = null
      timer = null
    }

    const start = () => {
      if (running || !animate || document.visibilityState !== "visible") return
      running = true
      lastFrameAt = performance.now()
      const schedule = () => {
        timer = window.setTimeout(() => {
          frame = window.requestAnimationFrame(() => {
            if (!running) return
            const now = performance.now()
            step(now - lastFrameAt)
            lastFrameAt = now
            draw()
            schedule()
          })
        }, 1000 / FRAME_RATE[speed])
      }
      schedule()
    }

    const updatePlayState = () => {
      if (animate && document.visibilityState === "visible") start()
      else stop()
    }

    resize()
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize)
    resizeObserver?.observe(canvas)
    document.addEventListener("visibilitychange", updatePlayState)
    start()

    return () => {
      stop()
      resizeObserver?.disconnect()
      document.removeEventListener("visibilitychange", updatePlayState)
    }
  }, [animate, characters, density, speed])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-testid="project-card-digital-rain"
      data-density={density}
      data-speed={speed}
      data-animating={animate}
      className="size-full bg-black"
    />
  )
}
