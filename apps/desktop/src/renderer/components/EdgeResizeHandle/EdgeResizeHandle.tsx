import { cn } from "@skipper/ui"
import type { PointerEvent as ReactPointerEvent } from "react"

/**
 * A thin draggable handle on one vertical edge of a panel that continuously
 * resizes the panel's width. A pointer drag adds the horizontal delta to the
 * starting width for a `right`-edge handle, or subtracts it for a `left`-edge one
 * (so dragging *outward* always grows the panel), clamps to `[min, max]`, and
 * reports the new width live via `onResize`. Pointer capture keeps the gesture
 * alive when the cursor leaves the 1.5px strip; the move/up/cancel listeners are
 * torn down on release. Marked `app-no-drag` so it stays interactive over the
 * window's drag region, and `aria-hidden` (it's a pointer affordance, not content).
 * It never throws.
 *
 * Sibling of the panel it resizes inside a `relative` parent; the panel's own
 * width is owned by a persisted preference the caller passes in/out.
 */
export function EdgeResizeHandle({
  side,
  width,
  min,
  max,
  onResize,
  testId,
}: {
  /** Which edge of the panel the handle sits on (and the grow direction). */
  side: "left" | "right"
  /** Current panel width in px. */
  width: number
  /** Clamp bounds for the resized width. */
  min: number
  max: number
  /** Report the new clamped width as the user drags. */
  onResize: (next: number) => void
  testId?: string
}) {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)

    const onMove = (move: PointerEvent) => {
      const delta = move.clientX - startX
      const next = side === "left" ? startWidth - delta : startWidth + delta
      onResize(Math.min(Math.max(next, min), max))
    }
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", cleanup)
      window.removeEventListener("pointercancel", cleanup)
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", cleanup)
    window.addEventListener("pointercancel", cleanup)
  }

  return (
    <div
      data-testid={testId}
      aria-hidden
      onPointerDown={onPointerDown}
      className={cn(
        "app-no-drag absolute inset-y-0 z-20 w-1.5 cursor-col-resize transition-colors hover:bg-primary/30",
        side === "left" ? "-left-1.5" : "-right-1.5",
      )}
    />
  )
}
