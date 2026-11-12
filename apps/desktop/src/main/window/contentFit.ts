import { type BrowserWindow, screen } from "electron"

interface SavedWindowState {
  bounds: Electron.Rectangle
  minimumSize: [number, number]
}

const saved = new WeakMap<BrowserWindow, SavedWindowState>()

/**
 * Resize a window so its content area is `width` x `height`, capped at the work
 * area of its display and centered there. The first call remembers the previous
 * bounds and minimum size so `restoreWindowSize` can put them back.
 */
export function fitWindowToContent(window: BrowserWindow, width: number, height: number): void {
  if (!saved.has(window)) {
    saved.set(window, {
      bounds: window.getBounds(),
      minimumSize: window.getMinimumSize() as [number, number],
    })
  }
  const area = screen.getDisplayMatching(window.getBounds()).workArea
  window.setMinimumSize(0, 0)
  window.setContentSize(Math.min(width, area.width), Math.min(height, area.height))
  const bounds = window.getBounds()
  window.setPosition(
    Math.round(area.x + (area.width - bounds.width) / 2),
    Math.round(area.y + (area.height - bounds.height) / 2),
  )
}

/** Undo `fitWindowToContent`: previous size, position and minimum size. No-op if nothing was saved. */
export function restoreWindowSize(window: BrowserWindow): void {
  const state = saved.get(window)
  if (!state) return
  saved.delete(window)
  window.setMinimumSize(state.minimumSize[0], state.minimumSize[1])
  window.setBounds(state.bounds)
}
