import { useCallback, useEffect, useState } from "react"

/**
 * The dashboard card-size control (md/02 — "cards are large by default; provide a
 * slider to increase/decrease card size"). The size is the card grid's *minimum
 * column width* in pixels: a larger value ⇒ fewer, larger cards per row. It is
 * persisted to `localStorage` so the user's preferred density survives reloads.
 *
 * Kept as a small hook (state + clamp + persistence) so the toolbar slider and
 * the grid both read one source of truth, and so it is trivially testable.
 */

const STORAGE_KEY = "skipper.dashboard.cardSize"

/** Card minimum column width, in pixels. Clamped to this range. */
export const MIN_CARD_SIZE = 200
export const MAX_CARD_SIZE = 480
export const DEFAULT_CARD_SIZE = 340

/** Clamp an arbitrary number into the valid card-size range, defaulting NaN. */
export function clampCardSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CARD_SIZE
  return Math.min(MAX_CARD_SIZE, Math.max(MIN_CARD_SIZE, Math.round(value)))
}

function readStoredSize(): number {
  if (typeof window === "undefined") return DEFAULT_CARD_SIZE
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw === null) return DEFAULT_CARD_SIZE
  return clampCardSize(Number.parseInt(raw, 10))
}

export interface UseCardSize {
  /** Current card size (min column width in px), always within range. */
  size: number
  /** Set the size (clamped) and persist it to localStorage. */
  setSize: (next: number) => void
}

export function useCardSize(): UseCardSize {
  const [size, setSizeState] = useState<number>(readStoredSize)

  // Persist on change. Wrapped in try/catch so a disabled/full localStorage
  // (private mode, quota) never crashes the dashboard — the size just won't stick.
  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      window.localStorage.setItem(STORAGE_KEY, String(size))
    } catch {
      // Persistence is best-effort; ignore storage failures.
    }
  }, [size])

  const setSize = useCallback((next: number) => {
    setSizeState(clampCardSize(next))
  }, [])

  return { size, setSize }
}
