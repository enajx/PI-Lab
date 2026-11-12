import { cn } from "@pi-lab/ui"
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef } from "react"

/**
 * A thin draggable handle on one vertical edge of a panel that continuously
 * resizes the panel's width. A pointer drag adds the horizontal delta to the
 * starting width for a `right`-edge handle, or subtracts it for a `left`-edge one
 * (so dragging *outward* always grows the panel), clamps to `[min, max]`, and
 * reports the new width live via `onResize`, then calls `onResizeEnd` once on
 * release after a width-changing drag. Cancellation does not commit the width.
 * With `onCollapse`, dragging the panel below `min` (or below its start width,
 * when it is drawn narrower than `min`) ends the drag and calls it
 * (the panel's own collapse, as if its collapse button was clicked); the width is
 * not committed then.
 * Pointer capture keeps the gesture
 * alive when the cursor leaves the 1.5px strip; the move/up/cancel listeners are
 * torn down on release, cancellation or unmount. Marked `app-no-drag` so it stays interactive over the
 * window's drag region, and `aria-hidden` (it's a pointer affordance, not content).
 * Sibling of the panel it resizes inside a `relative` parent; the panel's own
 * live width and persistence are owned by the caller.
 */
export function EdgeResizeHandle({
  side,
  width,
  min,
  max,
  onResize,
  onResizeEnd,
  onCollapse,
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
  /** Persist the final clamped width after a completed drag. */
  onResizeEnd?: (next: number) => void
  /** Collapse the panel when it is dragged below `min`. */
  onCollapse?: () => void
  testId?: string
}) {
  const callbacks = useRef({ onResize, onResizeEnd, onCollapse })
  const activeCleanup = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    callbacks.current = { onResize, onResizeEnd, onCollapse }
  }, [onResize, onResizeEnd, onCollapse])
  useEffect(() => () => activeCleanup.current?.(), [])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    activeCleanup.current?.()
    const startX = event.clientX
    const startWidth = width
    const target = event.currentTarget
    const pointerId = event.pointerId
    let nextWidth = startWidth
    let changedWidth = false
    // A panel drawn narrower than `min` (squeezed by its row) collapses when dragged
    // below the width it started at.
    const collapseBelow = Math.min(min, startWidth)
    target.setPointerCapture(pointerId)

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return
      const delta = move.clientX - startX
      const next = side === "left" ? startWidth - delta : startWidth + delta
      const collapse = callbacks.current.onCollapse
      if (collapse && next < collapseBelow) {
        cleanup()
        collapse()
        return
      }
      nextWidth = Math.min(Math.max(next, min), max)
      changedWidth ||= nextWidth !== startWidth
      callbacks.current.onResize(nextWidth)
    }
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
      activeCleanup.current = null
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
    }
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return
      cleanup()
      if (changedWidth) callbacks.current.onResizeEnd?.(nextWidth)
    }
    const onCancel = (cancel: PointerEvent) => {
      if (cancel.pointerId === pointerId) cleanup()
    }

    activeCleanup.current = cleanup
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
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
