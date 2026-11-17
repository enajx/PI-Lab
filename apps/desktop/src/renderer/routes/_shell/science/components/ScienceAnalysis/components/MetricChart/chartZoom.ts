import { useEffect, useRef, useState } from "react"

/**
 * View-only zoom on a chart's x axis, shared by the Analysis charts. The user
 * drags across the chart to pick an x range, or uses the +, − and reset
 * buttons. The zoom is never saved and is dropped when the data changes.
 */

/** A closed x range, `min` ≤ `max`, in data units. */
export interface XRange {
  min: number
  max: number
}

/** A zoom must keep at least this many data points in view. */
export const MIN_ZOOM_POINTS = 2
/** A drag shorter than this (in pixels) is a click, not a zoom. */
export const MIN_DRAG_PIXELS = 4

/** The smallest range holding every value, or null when there are none. */
export function rangeOf(values: readonly number[]): XRange | null {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    if (value < min) min = value
    if (value > max) max = value
  }
  return min <= max ? { min, max } : null
}

/** The middle half of `view`: half as wide, same centre. */
export function zoomInRange(view: XRange): XRange {
  const centre = (view.min + view.max) / 2
  const quarter = (view.max - view.min) / 4
  return { min: centre - quarter, max: centre + quarter }
}

/** Twice as wide as `view`, same centre where possible, kept inside `full`. */
export function zoomOutRange(view: XRange, full: XRange): XRange {
  const width = (view.max - view.min) * 2
  if (width >= full.max - full.min) return full
  const centre = (view.min + view.max) / 2
  let min = centre - width / 2
  let max = centre + width / 2
  if (min < full.min) {
    max += full.min - min
    min = full.min
  }
  if (max > full.max) {
    min -= max - full.max
    max = full.max
  }
  return { min, max }
}

/**
 * `view` scaled by `factor` (below 1 zooms in) around `x`, which keeps its
 * place on the axis; kept inside `full`, and `full` once it would be wider.
 */
export function zoomAroundRange(view: XRange, full: XRange, x: number, factor: number): XRange {
  const width = (view.max - view.min) * factor
  if (width >= full.max - full.min) return full
  const share = view.max > view.min ? (x - view.min) / (view.max - view.min) : 0.5
  let min = x - share * width
  let max = min + width
  if (min < full.min) {
    max += full.min - min
    min = full.min
  }
  if (max > full.max) {
    min -= max - full.max
    max = full.max
  }
  return { min, max }
}

/**
 * The zoom factor of one wheel event: a trackpad pinch (which browsers send
 * as a wheel event with Ctrl held) or a mouse wheel. Scrolling up zooms in.
 */
export function wheelFactor(deltaY: number, pinch: boolean): number {
  return Math.exp(deltaY * (pinch ? 0.01 : 0.002))
}

/**
 * Call `onWheel` for wheel events over `element`, which then do not scroll
 * the page. React's own wheel handler cannot stop the scroll (it is passive).
 */
export function useWheel(
  element: HTMLElement | null,
  onWheel: (event: WheelEvent) => boolean,
): void {
  const latest = useRef(onWheel)
  latest.current = onWheel
  useEffect(() => {
    if (!element) return
    const handle = (event: WheelEvent) => {
      if (latest.current(event)) event.preventDefault()
    }
    element.addEventListener("wheel", handle, { passive: false })
    return () => element.removeEventListener("wheel", handle)
  }, [element])
}

/** How many of `values` fall inside `range`. */
export function countInRange(values: readonly number[], range: XRange): number {
  let count = 0
  for (const value of values) if (value >= range.min && value <= range.max) count++
  return count
}

/** Whether `x` lies inside `range`. */
export function inRange(x: number, range: XRange): boolean {
  return x >= range.min && x <= range.max
}

/**
 * The x value under a pixel of a chart whose plot area spans `plotLeft` to
 * `plotRight` (pixels from the chart's left edge) and shows `view`. Pixels
 * outside the plot area give the nearest end of `view`.
 */
export function xAtPixel(px: number, plotLeft: number, plotRight: number, view: XRange): number {
  const span = plotRight - plotLeft
  if (span <= 0) return view.min
  const fraction = Math.min(1, Math.max(0, (px - plotLeft) / span))
  return view.min + fraction * (view.max - view.min)
}

interface Drag {
  startX: number
  endX: number
  startPx: number
  endPx: number
}

/** A point under the mouse: its x value and its pixel from the chart's left edge. */
export interface DragPoint {
  x: number
  px: number
}

export interface ChartZoom {
  /** The x range on screen: the zoomed range, or `full` when not zoomed. */
  view: XRange
  zoomed: boolean
  /** The range being dragged over, for the selection shading; null when not dragging. */
  selection: XRange | null
  canZoomIn: boolean
  zoomIn: () => void
  zoomOut: () => void
  /** Scale the view by `factor` around `x` (a pinch or the mouse wheel). */
  zoomAround: (x: number, factor: number) => void
  reset: () => void
  /** Begin a drag at x value `x`, at pixel `px` from the chart's left edge. */
  startDrag: (x: number, px: number) => void
  /** Move the end of a drag in progress; does nothing when not dragging. */
  moveDrag: (x: number, px: number) => void
  /**
   * End a drag at `end` (or where it last moved, when null): zoom to the
   * dragged range if it is wide enough and holds enough points.
   */
  endDrag: (end: DragPoint | null) => void
}

/**
 * Zoom state for one chart. `full` is the x range of all the data and
 * `values` the x value of every plotted point (to refuse zooms that would show
 * fewer than {@link MIN_ZOOM_POINTS} points). A zoom made for one `full` range
 * is dropped as soon as `full` changes, so new data always shows in full.
 */
export function useChartZoom(full: XRange, values: readonly number[]): ChartZoom {
  const [zoom, setZoom] = useState<{ range: XRange; full: XRange } | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)

  const current = zoom && zoom.full.min === full.min && zoom.full.max === full.max ? zoom : null
  const view = current ? current.range : full
  const canZoomIn = countInRange(values, zoomInRange(view)) >= MIN_ZOOM_POINTS

  const show = (range: XRange): void => {
    const isFull = range.min <= full.min && range.max >= full.max
    setZoom(isFull ? null : { range, full })
  }

  return {
    view,
    zoomed: current !== null,
    selection: drag
      ? { min: Math.min(drag.startX, drag.endX), max: Math.max(drag.startX, drag.endX) }
      : null,
    canZoomIn,
    zoomIn: () => {
      if (canZoomIn) show(zoomInRange(view))
    },
    zoomOut: () => show(zoomOutRange(view, full)),
    zoomAround: (x, factor) => {
      const range = zoomAroundRange(view, full, x, factor)
      if (factor < 1 && countInRange(values, range) < MIN_ZOOM_POINTS) return
      show(range)
    },
    reset: () => setZoom(null),
    startDrag: (x, px) => setDrag({ startX: x, endX: x, startPx: px, endPx: px }),
    moveDrag: (x, px) =>
      setDrag((previous) => (previous ? { ...previous, endX: x, endPx: px } : null)),
    endDrag: (end) => {
      if (!drag) return
      setDrag(null)
      const endX = end ? end.x : drag.endX
      const endPx = end ? end.px : drag.endPx
      if (Math.abs(endPx - drag.startPx) < MIN_DRAG_PIXELS) return
      const range = {
        min: Math.max(full.min, Math.min(drag.startX, endX)),
        max: Math.min(full.max, Math.max(drag.startX, endX)),
      }
      if (countInRange(values, range) < MIN_ZOOM_POINTS) return
      show(range)
    },
  }
}

/** The parts of recharts' mouse event state that zoom reads. */
export interface ChartMouseState {
  chartX?: number
  activeLabel?: string
}

/**
 * Recharts chart props that drive `zoom` from the mouse: press, drag and
 * release to zoom, double-click to reset. `xOf` turns the mouse state into an
 * x value, or null when the mouse is not over a usable spot. Recharts passes
 * null state when the mouse is outside the plot area. Leaving the chart
 * while dragging ends the drag where it last was.
 */
export function zoomMouseHandlers(
  zoom: ChartZoom,
  xOf: (state: ChartMouseState) => number | null,
): {
  onMouseDown: (state: ChartMouseState | null) => void
  onMouseMove: (state: ChartMouseState | null) => void
  onMouseUp: (state: ChartMouseState | null) => void
  onMouseLeave: () => void
  onDoubleClick: () => void
} {
  const pointOf = (state: ChartMouseState | null): DragPoint | null => {
    if (!state || typeof state.chartX !== "number") return null
    const x = xOf(state)
    return x === null ? null : { x, px: state.chartX }
  }
  return {
    onMouseDown: (state) => {
      const point = pointOf(state)
      if (point) zoom.startDrag(point.x, point.px)
    },
    onMouseMove: (state) => {
      if (!zoom.selection) return
      const point = pointOf(state)
      if (point) zoom.moveDrag(point.x, point.px)
    },
    onMouseUp: (state) => zoom.endDrag(pointOf(state)),
    onMouseLeave: () => zoom.endDrag(null),
    onDoubleClick: () => zoom.reset(),
  }
}

/**
 * A ref for a chart's element: a pinch or mouse wheel over it zooms the x
 * axis around the pointer. `xOfPixel` turns a pixel from the element's left
 * edge into an x value.
 */
export function useWheelZoom(
  zoom: ChartZoom,
  xOfPixel: (px: number) => number,
): (node: HTMLElement | null) => void {
  const [element, setElement] = useState<HTMLElement | null>(null)
  useWheel(element, (event) => {
    if (event.deltaY === 0) return false
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    zoom.zoomAround(xOfPixel(event.clientX - rect.left), wheelFactor(event.deltaY, event.ctrlKey))
    return true
  })
  return setElement
}
