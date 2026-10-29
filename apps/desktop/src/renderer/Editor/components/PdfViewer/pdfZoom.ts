/** Zoom presets that Shift + wheel steps through. */
export const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
const MIN_ZOOM = 0.5
const MAX_ZOOM = 3
/** Wheel delta that changes a pinch zoom by a factor of e. */
const PINCH_SENSITIVITY = 100
/** Treat scales this close to a preset as that preset. */
const EPSILON = 0.001

export interface ZoomWheel {
  ctrlKey: boolean
  shiftKey: boolean
  deltaX: number
  deltaY: number
}

const clamp = (scale: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale))

/**
 * The new PDF scale for a zoom wheel event, or null when the event should scroll.
 * Chromium reports a trackpad pinch as a wheel with ctrlKey set. A Shift + wheel steps
 * between presets; macOS may report its delta in deltaX instead of deltaY.
 */
export function wheelZoom(scale: number, event: ZoomWheel): number | null {
  if (event.ctrlKey) return clamp(scale * Math.exp(-event.deltaY / PINCH_SENSITIVITY))
  if (!event.shiftKey) return null
  const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX
  if (delta < 0) return ZOOM_PRESETS.find((preset) => preset > scale + EPSILON) ?? MAX_ZOOM
  if (delta > 0) return ZOOM_PRESETS.findLast((preset) => preset < scale - EPSILON) ?? MIN_ZOOM
  return clamp(scale)
}

export interface Point {
  x: number
  y: number
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/**
 * The scroll change that keeps the page point under the pointer in place after a zoom.
 * `before` and `after` are the client rects of the page under the pointer before and
 * after the scale change; the point keeps its relative position inside the page.
 */
export function anchorScroll(
  pointer: Point,
  before: Box,
  after: Box,
): { left: number; top: number } {
  const x = after.left + ((pointer.x - before.left) / before.width) * after.width
  const y = after.top + ((pointer.y - before.top) / before.height) * after.height
  return { left: x - pointer.x, top: y - pointer.y }
}

/** Status bar text: a transient refresh state, the current page, or both. */
export function pdfStatusText(message: string | null, page: number, pages: number): string {
  if (pages === 0) return message ?? ""
  const position = `Page ${page} / ${pages}`
  return message ? `${message} · ${position}` : position
}
